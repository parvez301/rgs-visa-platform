import { render, screen } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../src/AppProviders";
import { useAgentPanelSession } from "../../src/crm/agent/AgentPanelProvider";
import { useUndoToast } from "../../src/crm/UndoToast";
import { useAuth } from "../../src/lib/auth";

/**
 * Every CRM test file wraps its subject in the providers it needs by hand,
 * which is exactly how `UndoToastProvider` went unmounted in production: the
 * suite was green while `/crm` on staging threw "useUndoToast must be called
 * beneath an UndoToastProvider" and rendered a blank page (2026-09-16).
 *
 * This file renders the ONE provider tree `main.tsx` mounts and proves that
 * every context the routed screens reach for is actually supplied by it.
 * The probe calls each hook unconditionally, so a provider dropped from
 * `AppProviders` fails here rather than on the deployed page.
 */
function ContextProbe() {
  useQueryClient();
  useAuth();
  useAgentPanelSession();
  const { showUndo } = useUndoToast();
  return <p>{typeof showUndo === "function" ? "every context reached" : "undo missing"}</p>;
}

describe("AppProviders", () => {
  it("supplies every context the CRM screens call unconditionally", () => {
    render(
      <AppProviders>
        <ContextProbe />
      </AppProviders>,
    );
    expect(screen.getByText("every context reached")).toBeInTheDocument();
  });
});
