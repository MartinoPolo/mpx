import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import type { ProjectConfig, UserConfig } from "./types.js";
const ajv = new Ajv2020({allErrors:true, strict:true});
function load(name:string):object { return JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url),"utf8")) as object }
export const validateProject = ajv.compile<ProjectConfig>(load("mpxconfig.schema.json"));
export const validateUserConfig = ajv.compile<UserConfig>(load("user-config.schema.json"));
export class ConfigValidationError extends Error { constructor(public readonly errors: ErrorObject[]) { super(errors.map(e=>`${e.instancePath || "/"} ${e.message}`).join("; ")); this.name="ConfigValidationError" } }
export function assertValid<T>(validator: ValidateFunction<T>, value: unknown): asserts value is T { if(!validator(value)) throw new ConfigValidationError(validator.errors ? [...validator.errors] : []) }
