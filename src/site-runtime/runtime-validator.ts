import { ApplicationError } from "../app/errors/application-error.js";
import {
  RUNTIME_FIELD_TYPES,
  type SiteRuntimeCollectionSpec,
  type SiteRuntimeFieldSpec,
  type SiteRuntimeSpec,
} from "./runtime-types.js";

export interface RuntimeLimits {
  readonly maxCollections: number;
  readonly maxFieldsPerCollection: number;
  readonly maxRecordBytes: number;
  readonly maxStringLength: number;
  readonly defaultPageSize: number;
  readonly maxPageSize: number;
  readonly maxRequestBytes: number;
}
export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  maxCollections: 12,
  maxFieldsPerCollection: 24,
  maxRecordBytes: 32_000,
  maxStringLength: 8_000,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxRequestBytes: 64_000,
};
const identifier = /^[a-z][a-z0-9_]{0,62}$/;
const reserved = new Set(["id", "createdAt", "updatedAt", "siteId", "runtimeId"]);
export class SiteRuntimeSpecValidator {
  constructor(readonly limits: RuntimeLimits = DEFAULT_RUNTIME_LIMITS) {}
  validate(spec: SiteRuntimeSpec): SiteRuntimeSpec {
    if (!spec.enabled && spec.collections.length)
      this.#invalid("Disabled runtime cannot define collections");
    if (spec.collections.length > this.limits.maxCollections)
      this.#invalid("Runtime collection limit exceeded");
    const names = new Set<string>();
    for (const collection of spec.collections) {
      this.#name(collection.name, "collection");
      if (names.has(collection.name)) this.#invalid(`Duplicate collection: ${collection.name}`);
      names.add(collection.name);
      if (
        !collection.fields.length ||
        collection.fields.length > this.limits.maxFieldsPerCollection
      )
        this.#invalid(`Invalid field count for ${collection.name}`);
      const fields = new Set<string>();
      for (const field of collection.fields) {
        this.#name(field.name, "field");
        if (reserved.has(field.name)) this.#invalid(`Reserved field name: ${field.name}`);
        if (fields.has(field.name)) this.#invalid(`Duplicate field: ${field.name}`);
        fields.add(field.name);
        if (!RUNTIME_FIELD_TYPES.includes(field.type))
          this.#invalid(`Unsupported field type: ${String(field.type)}`);
        if (field.required && field.defaultValue !== undefined)
          this.validateValue(field, field.defaultValue);
      }
    }
    return spec;
  }
  validateRecord(
    collection: SiteRuntimeCollectionSpec,
    input: unknown,
    partial = false,
  ): Readonly<Record<string, string | number | boolean>> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      this.#validation("Record must be an object");
    const value = input as Record<string, unknown>;
    const fields = new Map(collection.fields.map((field) => [field.name, field]));
    for (const key of Object.keys(value))
      if (!fields.has(key)) this.#validation(`Unknown field: ${key}`);
    const output: Record<string, string | number | boolean> = {};
    for (const field of collection.fields) {
      const candidate = value[field.name];
      if (candidate === undefined) {
        if (!partial && field.required && field.defaultValue === undefined)
          this.#validation(`Required field missing: ${field.name}`);
        if (!partial && field.defaultValue !== undefined) output[field.name] = field.defaultValue;
        continue;
      }
      this.validateValue(field, candidate);
      output[field.name] = candidate as string | number | boolean;
    }
    if (Buffer.byteLength(JSON.stringify(output)) > this.limits.maxRecordBytes)
      this.#validation("Runtime record exceeds byte limit");
    return output;
  }
  validateValue(field: SiteRuntimeFieldSpec, value: unknown): void {
    if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
      this.#validation(`${field.name} must be a number`);
    if (field.type === "boolean" && typeof value !== "boolean")
      this.#validation(`${field.name} must be a boolean`);
    if (!["number", "boolean"].includes(field.type)) {
      if (typeof value !== "string") this.#validation(`${field.name} must be a string`);
      const text = value;
      if (text.length > (field.maxLength ?? this.limits.maxStringLength))
        this.#validation(`${field.name} is too long`);
      if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
        this.#validation(`${field.name} must be an email`);
      if (field.type === "url") {
        try {
          new URL(text);
        } catch {
          this.#validation(`${field.name} must be a URL`);
        }
      }
      if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text))
        this.#validation(`${field.name} must be a date`);
      if (field.type === "datetime" && Number.isNaN(Date.parse(text)))
        this.#validation(`${field.name} must be a datetime`);
    }
  }
  #name(value: string, kind: string): void {
    if (!identifier.test(value)) this.#invalid(`Unsafe ${kind} name: ${value}`);
  }
  #invalid(message: string): never {
    throw new ApplicationError("RUNTIME_SCHEMA_INVALID", message);
  }
  #validation(message: string): never {
    throw new ApplicationError("RUNTIME_VALIDATION_FAILED", message);
  }
}
