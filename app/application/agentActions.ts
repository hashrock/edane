/**
 * Application layer: the edits the in-page WebMCP tool (`apply_note`,
 * components/webmcp.ts) sends, validated and applied through the reducer.
 * Pure — no DOM, no WebMCP API — so the sync tests drive it headless.
 */
import { editorReducer, type EditorAction, type EditorState } from "./editorReducer";
import { findNode } from "../domain/model";

/** The JSON Schema of one action, as `apply_note` declares it. */
export const agentActionProperties = {
  type: { type: "string", enum: ["setTitle", "setNodeContent", "addChild", "deleteNode", "moveBranch", "addRootAt", "placeBranchAt", "setChecked", "setSchema"] },
  nodeId: { type: "string" }, text: { type: "string" },
  newParentId: { type: "string" }, index: { type: "integer", minimum: 0 },
  x: { type: "number" }, y: { type: "number" }, checked: { type: ["boolean", "null"] }, schema: { type: ["string", "null"] },
};

export function prepareActions(state: EditorState, input: unknown): EditorState {
  const actions = (input as { actions?: unknown[] })?.actions;
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 100) throw new Error("actions must contain 1–100 edits");
  if (JSON.stringify(input).length > 500000) throw new Error("Input too large");
  let next = state;
  for (const value of actions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid action");
    const a = value as Record<string, unknown>;
    let keys: string[];
    const string = (key: string) => { if (typeof a[key] !== "string") throw new Error(`${key} must be a string`); };
    const node = (key: string) => { string(key); if (!findNode(next.document.model, a[key] as string)) throw new Error(`Unknown ${key}: ${a[key]}`); };
    switch (a.type) {
      case "setTitle": string("text"); keys = ["text"]; break;
      case "setNodeContent": node("nodeId"); string("text"); keys = ["nodeId", "text"]; break;
      case "addChild": case "deleteNode": node("nodeId"); keys = ["nodeId"]; break;
      case "moveBranch":
        node("nodeId"); node("newParentId");
        if (a.index !== undefined && (!Number.isSafeInteger(a.index) || (a.index as number) < 0)) throw new Error("Invalid index");
        keys = ["nodeId", "newParentId", "index"]; break;
      case "placeBranchAt": case "addRootAt":
        if (a.type === "placeBranchAt") node("nodeId");
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) throw new Error("Invalid position");
        keys = a.type === "placeBranchAt" ? ["nodeId", "x", "y"] : ["x", "y"]; break;
      case "setChecked":
        node("nodeId"); if (a.checked !== null && typeof a.checked !== "boolean") throw new Error("Invalid checked");
        keys = ["nodeId", "checked"]; break;
      case "setSchema":
        node("nodeId"); if (a.schema !== null && typeof a.schema !== "string") throw new Error("Invalid schema");
        keys = ["nodeId", "schema"]; break;
      default: throw new Error("Unsupported action");
    }
    if (Object.keys(a).some(k => k !== "type" && !keys.includes(k))) throw new Error("Unknown action field");
    next = editorReducer(next, a as EditorAction);
  }
  // Agent edits don't take over the user's caret or selection.
  return editorReducer(state, { type: "replace", state: { document: next.document, view: state.view } });
}
