import { describe, expect, it } from "vitest";
import { z } from "zod";
import { pickProvided } from "@/lib/api/handler";
import { projectSchema } from "@/lib/validation/projects";
import { workflowSchema } from "@/lib/validation/automation";

describe("PATCH parsing keeps only fields the client sent", () => {
  it("does not reset defaulted project fields on a status-only update", () => {
    const raw = { status: "scripting" };
    const out = pickProvided(raw, projectSchema.partial().parse(raw) as Record<string, unknown>);
    expect(out).toEqual({ status: "scripting" });
    expect(out).not.toHaveProperty("format");
    expect(out).not.toHaveProperty("platforms");
  });
  it("does not re-enable a workflow when only its name changes", () => {
    const raw = { name: "Renamed" };
    expect(pickProvided(raw, workflowSchema.partial().parse(raw) as Record<string, unknown>)).toEqual({ name: "Renamed" });
  });
  it("still validates provided fields", () => {
    expect(() => projectSchema.partial().parse({ status: "nope" })).toThrow();
    expect(z.object({ a: z.string().default("x") }).partial().parse({})).toEqual({ a: "x" }); // documents the Zod 4 behavior we guard against
  });
});
