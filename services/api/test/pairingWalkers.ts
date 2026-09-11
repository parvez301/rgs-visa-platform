import { expect } from "vitest";
import { mapMessagesToAnthropic } from "../src/agent/providers/anthropic";
import { mapMessagesToGemini } from "../src/agent/providers/gemini";
import type { AgentMessage } from "../src/agent/providers/types";

/**
 * The pairing invariant both real vendor APIs enforce, as walkers over a
 * MAPPED request -- shared so that every test which produces a transcript can
 * be judged by the same rule, wherever the transcript came from.
 *
 * Extracted from test/agent/toolCallPairing.test.ts by branch-fix re-review
 * N3: the loop's own transcripts were walked, but a transcript replayed by a
 * client through the turn route was only checked for the PRESENCE of a
 * tool_use block, which is a weaker claim than pairing and the same
 * assert-the-shape habit the branch review faulted elsewhere.
 */

export type AnthropicBlock = { type?: string; id?: string; tool_use_id?: string; [key: string]: unknown };
export type AnthropicMessage = { role?: string; content?: unknown };
export type GeminiPart = {
  text?: string;
  functionCall?: { name?: string };
  functionResponse?: { name?: string };
};
export type GeminiContent = { role?: string; parts?: unknown };

export function anthropicBlocks(message: AnthropicMessage): AnthropicBlock[] {
  return Array.isArray(message.content) ? (message.content as AnthropicBlock[]) : [];
}

export function geminiParts(content: GeminiContent): GeminiPart[] {
  return Array.isArray(content.parts) ? (content.parts as GeminiPart[]) : [];
}

/**
 * Every way the Anthropic Messages API can refuse a transcript for pairing
 * reasons, collected rather than thrown one at a time, so a failure names all
 * of them at once instead of one per re-run.
 */
export function anthropicPairingViolations(mappedMessages: AnthropicMessage[]): string[] {
  const violations: string[] = [];
  let previousWasToolResultMessage = false;

  mappedMessages.forEach((message, messageIndex) => {
    const toolResultBlocks = anthropicBlocks(message).filter((block) => block.type === "tool_result");
    if (toolResultBlocks.length === 0) {
      previousWasToolResultMessage = false;
      return;
    }

    if (message.role !== "user") {
      violations.push(`message ${messageIndex}: tool_result blocks must sit on a user message, not "${message.role}"`);
    }
    if (previousWasToolResultMessage) {
      violations.push(
        `message ${messageIndex}: two consecutive user messages both carry tool_result blocks -- ` +
          "all results answering one assistant turn must be batched into a single message",
      );
    }
    previousWasToolResultMessage = true;

    const precedingMessage = mappedMessages[messageIndex - 1];
    if (precedingMessage === undefined || precedingMessage.role !== "assistant") {
      violations.push(
        `message ${messageIndex}: tool_result blocks must immediately follow an assistant message, ` +
          `but the preceding message is ${precedingMessage === undefined ? "nothing" : `"${precedingMessage.role}"`}`,
      );
      return;
    }

    const transmittedToolUseIds = new Set(
      anthropicBlocks(precedingMessage)
        .filter((block) => block.type === "tool_use")
        .map((block) => block.id),
    );
    for (const toolResultBlock of toolResultBlocks) {
      if (!transmittedToolUseIds.has(toolResultBlock.tool_use_id as string)) {
        violations.push(
          `message ${messageIndex}: tool_result names tool_use_id "${String(toolResultBlock.tool_use_id)}", ` +
            `which no tool_use block in the preceding assistant message carries ` +
            `(it carries: ${[...transmittedToolUseIds].map(String).join(", ") || "none"})`,
        );
      }
    }
  });

  return violations;
}

/** The Gemini twin: functionResponse parts, paired by function NAME. */
export function geminiPairingViolations(mappedContents: GeminiContent[]): string[] {
  const violations: string[] = [];
  let previousWasFunctionResponseTurn = false;

  mappedContents.forEach((content, contentIndex) => {
    const functionResponseParts = geminiParts(content).filter((part) => part.functionResponse !== undefined);
    if (functionResponseParts.length === 0) {
      previousWasFunctionResponseTurn = false;
      return;
    }

    if (content.role !== "user") {
      violations.push(`content ${contentIndex}: functionResponse parts must sit on a user turn, not "${content.role}"`);
    }
    if (previousWasFunctionResponseTurn) {
      violations.push(
        `content ${contentIndex}: two consecutive user turns both carry functionResponse parts -- ` +
          "all responses answering one model turn must be batched into a single turn",
      );
    }
    previousWasFunctionResponseTurn = true;

    const precedingContent = mappedContents[contentIndex - 1];
    if (precedingContent === undefined || precedingContent.role !== "model") {
      violations.push(
        `content ${contentIndex}: functionResponse parts must immediately follow a model turn, ` +
          `but the preceding turn is ${precedingContent === undefined ? "nothing" : `"${precedingContent.role}"`}`,
      );
      return;
    }

    const transmittedFunctionNames = new Set(
      geminiParts(precedingContent)
        .filter((part) => part.functionCall !== undefined)
        .map((part) => part.functionCall?.name),
    );
    for (const functionResponsePart of functionResponseParts) {
      if (!transmittedFunctionNames.has(functionResponsePart.functionResponse?.name)) {
        violations.push(
          `content ${contentIndex}: functionResponse names "${String(functionResponsePart.functionResponse?.name)}", ` +
            `which no functionCall part in the preceding model turn carries ` +
            `(it carries: ${[...transmittedFunctionNames].map(String).join(", ") || "none"})`,
        );
      }
    }
  });

  return violations;
}

export function countAnthropicBlocks(mappedMessages: AnthropicMessage[], blockType: string): number {
  return mappedMessages.reduce(
    (runningTotal, message) =>
      runningTotal + anthropicBlocks(message).filter((block) => block.type === blockType).length,
    0,
  );
}

export function countGeminiParts(mappedContents: GeminiContent[], partKey: "functionCall" | "functionResponse"): number {
  return mappedContents.reduce(
    (runningTotal, content) => runningTotal + geminiParts(content).filter((part) => part[partKey] !== undefined).length,
    0,
  );
}

/**
 * The whole invariant, asserted through both real mappers at once, with a
 * floor on how many pairs it saw. The floor is what stops this from passing
 * vacuously: a transcript with no tool_result blocks in it satisfies "every
 * tool_result is paired" trivially, and that is exactly the state a
 * regression in the loop would produce.
 */
export function expectEveryToolResultPaired(sentMessages: AgentMessage[], expectedPairCount: number): void {
  const anthropicMessages = mapMessagesToAnthropic(sentMessages) as AnthropicMessage[];
  const geminiContents = mapMessagesToGemini(sentMessages) as GeminiContent[];

  expect(anthropicPairingViolations(anthropicMessages), "Anthropic pairing").toEqual([]);
  expect(geminiPairingViolations(geminiContents), "Gemini pairing").toEqual([]);

  expect(countAnthropicBlocks(anthropicMessages, "tool_result")).toBe(expectedPairCount);
  expect(countAnthropicBlocks(anthropicMessages, "tool_use")).toBe(expectedPairCount);
  expect(countGeminiParts(geminiContents, "functionResponse")).toBe(expectedPairCount);
  expect(countGeminiParts(geminiContents, "functionCall")).toBe(expectedPairCount);
}
