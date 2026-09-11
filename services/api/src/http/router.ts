import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { ZodError, type ZodType } from "zod";
import { ApiError, badRequest } from "../lib/errors";

export interface RequestContext {
  /** Cognito subject (user or admin id). Empty string for unauthenticated routes. */
  callerId: string;
  callerEmail: string;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (requestContext: RequestContext) => Promise<unknown>;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pathPattern: string, handler: RouteHandler): this {
    this.routes.push({
      method,
      segments: pathPattern.split("/").filter(Boolean),
      handler,
    });
    return this;
  }

  /**
   * What this router actually has registered -- not a declaration of what
   * was meant to be registered. `task-11-fix-2-brief.md` A1/M4: a test that
   * enumerates a separate array a route table is *built from* can only ever
   * prove things about that array; nothing stops a second, later call to
   * `add` from registering a route that never touches the array at all, and
   * such a route would be invisible to a test driven off it. `add` stays
   * public and this router stays a plain mutable object -- the fix is not to
   * lock the router down, it is to make it able to say, truthfully, what is
   * actually on it, so a test can walk THAT instead of a stand-in for it.
   * `segments` was always the source of truth for matching; this just
   * reassembles it back into the same `pathPattern` string `add` was called
   * with (every caller in this codebase passes a single leading "/" and
   * single-"/"-separated segments, so the join is lossless).
   */
  get registeredRoutes(): { method: string; path: string }[] {
    return this.routes.map((route) => ({ method: route.method, path: `/${route.segments.join("/")}` }));
  }

  private match(
    method: string,
    path: string,
  ): { route: Route; pathParams: Record<string, string> } | undefined {
    const pathSegments = path.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== pathSegments.length) continue;
      const pathParams: Record<string, string> = {};
      let matched = true;
      for (let segmentIndex = 0; segmentIndex < route.segments.length; segmentIndex += 1) {
        const patternSegment = route.segments[segmentIndex]!;
        const pathSegment = pathSegments[segmentIndex]!;
        if (patternSegment.startsWith("{") && patternSegment.endsWith("}")) {
          pathParams[patternSegment.slice(1, -1)] = decodeURIComponent(pathSegment);
        } else if (patternSegment !== pathSegment) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, pathParams };
    }
    return undefined;
  }

  async dispatch(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    try {
      const matchResult = this.match(method, path);
      if (!matchResult) {
        throw new ApiError(404, "ROUTE_NOT_FOUND", `No route for ${method} ${path}`);
      }
      const jwtClaims =
        (
          event.requestContext as unknown as {
            authorizer?: { jwt?: { claims?: Record<string, string> } };
          }
        ).authorizer?.jwt?.claims ?? {};
      let parsedBody: unknown;
      if (event.body) {
        try {
          parsedBody = JSON.parse(event.body);
        } catch {
          throw badRequest("Request body must be valid JSON");
        }
      }
      const responsePayload = await matchResult.route.handler({
        callerId: jwtClaims["sub"] ?? "",
        callerEmail: jwtClaims["email"] ?? "",
        pathParams: matchResult.pathParams,
        queryParams: (event.queryStringParameters ?? {}) as Record<string, string>,
        body: parsedBody,
      });
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(responsePayload ?? {}),
      };
    } catch (error) {
      return errorToResponse(error);
    }
  }
}

export function parseBody<SchemaType extends ZodType>(
  schema: SchemaType,
  body: unknown,
): SchemaType["_output"] {
  try {
    return schema.parse(body ?? {});
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      throw badRequest(
        firstIssue
          ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
          : "Invalid request body",
      );
    }
    throw error;
  }
}

/**
 * A query parameter is caller input exactly as a body is, so a bad one is a
 * 400. Parsed with a bare `.parse()` it throws a ZodError, `errorToResponse`
 * below maps only ApiError, and a typo'd `?status=SUBMITTTED` answered 500
 * "Internal error" — which tells an operator the server is broken rather than
 * that they mistyped a word.
 */
export function parseQueryParam<SchemaType extends ZodType>(
  schema: SchemaType,
  parameterName: string,
  rawValue: string | undefined,
): SchemaType["_output"] {
  try {
    return schema.parse(rawValue);
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      throw badRequest(
        `${parameterName}: ${firstIssue ? firstIssue.message : "invalid value"}`,
      );
    }
    throw error;
  }
}

function errorToResponse(error: unknown): APIGatewayProxyResultV2 {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: error.code, message: error.message }),
    };
  }
  console.error("Unhandled error", error);
  return {
    statusCode: 500,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "INTERNAL", message: "Something went wrong" }),
  };
}
