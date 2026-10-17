// What every op.ts imports: `defineOp` typed with the X helpers, and the errors helpers throw.
import { defineOpFor } from "../core/ops";
import type { Xh } from "./helpers";

export const defineOp = defineOpFor<Xh>();
export { default as Type } from "typebox";
export { InputError, PreconditionError, RefusedError } from "../core/errors";
