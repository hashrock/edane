/**
 * Application layer: what the editors draw for branch schemas — a field-name
 * label on each field node, a mismatch mark where the node can't be read as
 * its field's type, and a badge on the node that holds a schema. One pure
 * derivation shared by the canvas (MindmapEditor) and the outline
 * (OutlineEditor), so the two layouts can't disagree on what a node is.
 */
import {
  fieldIssue,
  ownSchema,
  schemaRoles,
  valueTypeOf,
  type FieldType,
} from "../domain/branchSchema";
import type { MindMapDocument, MindMapModel } from "../domain/model";

export interface SchemaDecoration {
  /** Field key of a field node. */
  label?: string;
  /** Set when the node can't be read as this type (see `fieldIssue`). */
  issue?: FieldType;
  /** The node holds its own schema: its children are records. */
  collection?: boolean;
}

export function schemaDecorations(doc: MindMapDocument): Map<string, SchemaDecoration> {
  const out = new Map<string, SchemaDecoration>();
  const roles = schemaRoles(doc);
  const walk = (node: MindMapModel) => {
    const deco: SchemaDecoration = {};
    const role = roles.get(node.id);
    if (role?.kind === "field") deco.label = role.field.key;
    if (role) {
      const issue = fieldIssue(node, valueTypeOf(role));
      if (issue) deco.issue = issue;
    }
    if (ownSchema(node)) deco.collection = true;
    if (deco.label || deco.issue || deco.collection) out.set(node.id, deco);
    node.children.forEach(walk);
  };
  doc.roots.forEach(walk);
  return out;
}
