import { createHash } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";

export const MOTION_POLICY_PRESETS = ["NONE", "SUBTLE", "BALANCED", "EXPRESSIVE"] as const;
export type MotionPolicyPreset = (typeof MOTION_POLICY_PRESETS)[number];

export const MOTION_TRIGGERS = [
  "LOAD",
  "VIEWPORT_ENTER",
  "HOVER",
  "FOCUS",
  "PRESS",
  "EXPAND",
  "COLLAPSE",
  "STATE_CHANGE",
] as const;
export type MotionTrigger = (typeof MOTION_TRIGGERS)[number];

export const MOTION_EFFECTS = [
  "NONE",
  "FADE",
  "FADE_UP",
  "FADE_DOWN",
  "SLIDE_LEFT",
  "SLIDE_RIGHT",
  "SCALE_IN",
  "SCALE_HOVER",
  "LIFT_HOVER",
  "STAGGER",
  "EXPAND_COLLAPSE",
  "CROSSFADE",
] as const;
export type MotionEffect = (typeof MOTION_EFFECTS)[number];

export const MOTION_TARGET_CATEGORIES = [
  "PAGE",
  "HERO",
  "SECTION",
  "CARD_GROUP",
  "CARD",
  "BUTTON",
  "NAVIGATION",
  "MENU",
  "ACCORDION",
  "MODAL",
  "DECORATIVE",
] as const;
export type MotionTargetCategory = (typeof MOTION_TARGET_CATEGORIES)[number];

export const MOTION_EMPHASIS = ["SUBTLE", "BALANCED", "EXPRESSIVE"] as const;
export type MotionEmphasis = (typeof MOTION_EMPHASIS)[number];

export const REDUCED_MOTION_BEHAVIORS = [
  "DISABLE",
  "REDUCE",
  "PRESERVE_FUNCTIONAL",
] as const;
export type ReducedMotionBehavior = (typeof REDUCED_MOTION_BEHAVIORS)[number];

export const MOTION_IMPLEMENTATION_KINDS = ["CSS_NATIVE", "UI_COMPONENT"] as const;
export type MotionImplementationKind = (typeof MOTION_IMPLEMENTATION_KINDS)[number];

export const MOTION_CAPABILITIES = ["NONE", "motion-basic", "motion-advanced"] as const;
export type MotionCapability = (typeof MOTION_CAPABILITIES)[number];

export const MOTION_DURATION_TOKENS = [
  "duration.fast",
  "duration.normal",
  "duration.slow",
] as const;
export type MotionDurationToken = (typeof MOTION_DURATION_TOKENS)[number];

export const MOTION_EASING_TOKENS = [
  "ease.standard",
  "ease.enter",
  "ease.exit",
] as const;
export type MotionEasingToken = (typeof MOTION_EASING_TOKENS)[number];

export const MOTION_DISTANCE_TOKENS = ["distance.small", "distance.medium"] as const;
export type MotionDistanceToken = (typeof MOTION_DISTANCE_TOKENS)[number];

export const MOTION_SCALE_TOKENS = ["scale.hover"] as const;
export type MotionScaleToken = (typeof MOTION_SCALE_TOKENS)[number];

export const MOTION_STAGGER_TOKENS = ["stagger.short", "stagger.normal"] as const;
export type MotionStaggerToken = (typeof MOTION_STAGGER_TOKENS)[number];

export type MotionToken =
  | MotionDurationToken
  | MotionEasingToken
  | MotionDistanceToken
  | MotionScaleToken
  | MotionStaggerToken;

export const APPROVED_MOTION_CSS_TOKENS: readonly string[] = [
  ...MOTION_DURATION_TOKENS,
  ...MOTION_EASING_TOKENS,
  ...MOTION_DISTANCE_TOKENS,
  ...MOTION_SCALE_TOKENS,
  ...MOTION_STAGGER_TOKENS,
].map(motionTokenCssVariable);

/**
 * The single source of truth mapping a logical motion token (e.g.
 * `duration.fast`) to the literal CSS custom-property name the Sites-managed
 * motion stylesheet defines and the motion validator accepts (e.g.
 * `--sites-motion-duration-fast`). Callers that surface tokens to the model
 * or validate generated CSS must use this instead of re-deriving the name.
 */
export function motionTokenCssVariable(token: MotionToken): string {
  return `--sites-motion-${token.replace(".", "-")}`;
}

/**
 * The single source of truth mapping a `MotionEffect` (e.g. `FADE_UP`) to the
 * literal `data-sites-motion` attribute value the Sites-managed motion
 * stylesheet selects on (e.g. `fade-up`). Callers that surface primitives to
 * the model or validate generated markup must use this instead of
 * re-deriving the value - it is lowercase-hyphenated, not
 * lowercase-underscored, so a naive `.toLowerCase()` alone produces a value
 * the managed stylesheet does not select.
 */
export function motionPrimitiveAttributeValue(effect: MotionEffect): string {
  return effect.toLowerCase().replaceAll("_", "-");
}

export const APPROVED_MOTION_PRIMITIVE_ATTRIBUTE_VALUES: readonly string[] = MOTION_EFFECTS.filter(
  (effect) => effect !== "NONE",
).map(motionPrimitiveAttributeValue);

export interface MotionPolicy {
  readonly policyVersion: string;
  readonly preset: MotionPolicyPreset;
  readonly reducedMotion: "REQUIRED";
  readonly allowDecorativeLoops: false;
  readonly profileId: string;
}

export interface MotionTarget {
  readonly category: MotionTargetCategory;
  readonly semanticId?: string;
  readonly pageId?: string;
  readonly sectionId?: string;
}

export interface MotionIntent {
  readonly motionId: string;
  readonly target: MotionTarget;
  readonly trigger: MotionTrigger;
  readonly effect: MotionEffect;
  readonly emphasis: MotionEmphasis;
  readonly pageId?: string;
  readonly sectionId?: string;
  readonly required: boolean;
  readonly decorative: boolean;
  readonly stagger?: boolean;
}

export interface ApprovedMotionPrimitive {
  readonly id: MotionEffect;
  readonly triggers: readonly MotionTrigger[];
  readonly implementationKind: MotionImplementationKind;
  readonly reducedMotionBehavior: ReducedMotionBehavior;
  readonly durationToken: MotionDurationToken;
  readonly easingToken: MotionEasingToken;
  readonly distanceToken?: MotionDistanceToken;
  readonly staggerToken?: MotionStaggerToken;
  readonly scaleToken?: MotionScaleToken;
}

export interface ResolvedMotion {
  readonly motionId: string;
  readonly target: MotionTarget;
  readonly trigger: MotionTrigger;
  readonly primitive: MotionEffect;
  readonly durationToken: MotionDurationToken;
  readonly easingToken: MotionEasingToken;
  readonly distanceToken?: MotionDistanceToken;
  readonly staggerToken?: MotionStaggerToken;
  readonly reducedMotionBehavior: ReducedMotionBehavior;
  readonly implementationKind: MotionImplementationKind;
}

export interface ResolvedMotionPlan {
  readonly version: number;
  readonly policy: MotionPolicy;
  readonly capability: MotionCapability;
  readonly motions: readonly ResolvedMotion[];
}

const stableId = (value: string, label: string): string => {
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i.test(value))
    throw new ApplicationError("MOTION_VALIDATION_FAILED", `${label} must be a stable identifier`);
  return value;
};

const oneOf = <T extends string>(value: string, values: readonly T[], label: string): T => {
  if (!values.includes(value as T))
    throw new ApplicationError("MOTION_VALIDATION_FAILED", `${label} '${value}' is not supported`);
  return value as T;
};

const deepFreeze = <T>(value: T): T => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
};

const cloneTarget = (target: MotionTarget): MotionTarget => ({
  category: target.category,
  ...(target.semanticId === undefined ? {} : { semanticId: target.semanticId }),
  ...(target.pageId === undefined ? {} : { pageId: target.pageId }),
  ...(target.sectionId === undefined ? {} : { sectionId: target.sectionId }),
});

export function validateMotionPolicy(policy: MotionPolicy): void {
  stableId(policy.policyVersion, "policyVersion");
  oneOf(policy.preset, MOTION_POLICY_PRESETS, "policy preset");
  if (policy.reducedMotion !== "REQUIRED")
    throw new ApplicationError("MOTION_POLICY_VIOLATION", "Reduced motion is required");
  if (policy.allowDecorativeLoops !== false)
    throw new ApplicationError("MOTION_POLICY_VIOLATION", "Decorative loops are disabled in motion v1");
  stableId(policy.profileId, "profileId");
}

export function createMotionPolicy(input: {
  readonly policyVersion?: string;
  readonly preset?: MotionPolicyPreset;
  readonly profileId?: string;
} = {}): MotionPolicy {
  const policy: MotionPolicy = {
    policyVersion: input.policyVersion ?? "v1",
    preset: input.preset ?? "NONE",
    reducedMotion: "REQUIRED",
    allowDecorativeLoops: false,
    profileId: input.profileId ?? "react-vite-v1",
  };
  validateMotionPolicy(policy);
  return deepFreeze(policy);
}

export function validateMotionTarget(target: MotionTarget): void {
  oneOf(target.category, MOTION_TARGET_CATEGORIES, "motion target category");
  if (target.category !== "DECORATIVE" && !target.semanticId?.trim())
    throw new ApplicationError(
      "MOTION_VALIDATION_FAILED",
      `Motion target '${target.category}' requires a semanticId`,
    );
  for (const [value, label] of [
    [target.semanticId, "semanticId"],
    [target.pageId, "pageId"],
    [target.sectionId, "sectionId"],
  ] as const)
    if (value !== undefined) stableId(value, label);
}

export function createMotionIntent(input: MotionIntent): MotionIntent {
  const intent: MotionIntent = {
    motionId: stableId(input.motionId, "motionId"),
    target: cloneTarget(input.target),
    trigger: oneOf(input.trigger, MOTION_TRIGGERS, "motion trigger"),
    effect: oneOf(input.effect, MOTION_EFFECTS, "motion effect"),
    emphasis: oneOf(input.emphasis, MOTION_EMPHASIS, "motion emphasis"),
    ...(input.pageId === undefined ? {} : { pageId: stableId(input.pageId, "pageId") }),
    ...(input.sectionId === undefined
      ? {}
      : { sectionId: stableId(input.sectionId, "sectionId") }),
    required: input.required,
    decorative: input.decorative,
    ...(input.stagger === undefined ? {} : { stagger: input.stagger }),
  };
  validateMotionTarget(intent.target);
  if (typeof intent.required !== "boolean" || typeof intent.decorative !== "boolean")
    throw new ApplicationError("MOTION_VALIDATION_FAILED", "Motion required/decorative flags must be boolean");
  if (intent.stagger !== undefined && typeof intent.stagger !== "boolean")
    throw new ApplicationError("MOTION_VALIDATION_FAILED", "Motion stagger flag must be boolean");
  if (intent.decorative && intent.required)
    throw new ApplicationError("MOTION_POLICY_VIOLATION", "Decorative motion cannot be required");
  return deepFreeze(intent);
}

export function validateMotionIntents(intents: readonly MotionIntent[]): void {
  const ids = new Set<string>();
  for (const intent of intents) {
    validateMotionIntent(intent);
    if (ids.has(intent.motionId))
      throw new ApplicationError("MOTION_VALIDATION_FAILED", `Duplicate motion ID '${intent.motionId}'`);
    ids.add(intent.motionId);
  }
}

const primitive = (value: ApprovedMotionPrimitive): ApprovedMotionPrimitive => deepFreeze(value);

export const APPROVED_MOTION_PRIMITIVES: readonly ApprovedMotionPrimitive[] = [
  primitive({
    id: "NONE",
    triggers: ["STATE_CHANGE"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "PRESERVE_FUNCTIONAL",
    durationToken: "duration.fast",
    easingToken: "ease.standard",
  }),
  primitive({
    id: "FADE",
    triggers: ["LOAD", "VIEWPORT_ENTER", "STATE_CHANGE"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "DISABLE",
    durationToken: "duration.normal",
    easingToken: "ease.enter",
  }),
  primitive({
    id: "FADE_UP",
    triggers: ["LOAD", "VIEWPORT_ENTER"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "DISABLE",
    durationToken: "duration.normal",
    easingToken: "ease.enter",
    distanceToken: "distance.small",
  }),
  primitive({
    id: "FADE_DOWN",
    triggers: ["LOAD", "VIEWPORT_ENTER"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "DISABLE",
    durationToken: "duration.normal",
    easingToken: "ease.enter",
    distanceToken: "distance.small",
  }),
  primitive({
    id: "SLIDE_LEFT",
    triggers: ["LOAD", "VIEWPORT_ENTER", "STATE_CHANGE"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "DISABLE",
    durationToken: "duration.normal",
    easingToken: "ease.enter",
    distanceToken: "distance.medium",
  }),
  primitive({
    id: "SLIDE_RIGHT",
    triggers: ["LOAD", "VIEWPORT_ENTER", "STATE_CHANGE"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "DISABLE",
    durationToken: "duration.normal",
    easingToken: "ease.enter",
    distanceToken: "distance.medium",
  }),
  primitive({
    id: "SCALE_IN",
    triggers: ["LOAD", "VIEWPORT_ENTER"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "DISABLE",
    durationToken: "duration.normal",
    easingToken: "ease.enter",
    scaleToken: "scale.hover",
  }),
  primitive({
    id: "SCALE_HOVER",
    triggers: ["HOVER", "FOCUS", "PRESS"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "REDUCE",
    durationToken: "duration.fast",
    easingToken: "ease.standard",
    scaleToken: "scale.hover",
  }),
  primitive({
    id: "LIFT_HOVER",
    triggers: ["HOVER", "FOCUS", "PRESS"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "REDUCE",
    durationToken: "duration.fast",
    easingToken: "ease.standard",
    distanceToken: "distance.small",
  }),
  primitive({
    id: "STAGGER",
    triggers: ["LOAD", "VIEWPORT_ENTER"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "DISABLE",
    durationToken: "duration.normal",
    easingToken: "ease.enter",
    staggerToken: "stagger.normal",
  }),
  primitive({
    id: "EXPAND_COLLAPSE",
    triggers: ["EXPAND", "COLLAPSE"],
    implementationKind: "UI_COMPONENT",
    reducedMotionBehavior: "PRESERVE_FUNCTIONAL",
    durationToken: "duration.normal",
    easingToken: "ease.standard",
  }),
  primitive({
    id: "CROSSFADE",
    triggers: ["STATE_CHANGE", "LOAD"],
    implementationKind: "CSS_NATIVE",
    reducedMotionBehavior: "DISABLE",
    durationToken: "duration.normal",
    easingToken: "ease.enter",
  }),
];

export function getApprovedMotionPrimitive(id: string): ApprovedMotionPrimitive {
  const result = APPROVED_MOTION_PRIMITIVES.find((item) => item.id === id);
  if (!result)
    throw new ApplicationError("MOTION_UNSUPPORTED", `Motion primitive '${id}' is not approved`);
  return result;
}

const assertToken = <T extends string>(value: string, tokens: readonly T[], label: string): T =>
  oneOf(value, tokens, label);

export function validateMotionIntent(intent: MotionIntent): void {
  stableId(intent.motionId, "motionId");
  validateMotionTarget(intent.target);
  oneOf(intent.trigger, MOTION_TRIGGERS, "motion trigger");
  oneOf(intent.effect, MOTION_EFFECTS, "motion effect");
  oneOf(intent.emphasis, MOTION_EMPHASIS, "motion emphasis");
  if (typeof intent.required !== "boolean" || typeof intent.decorative !== "boolean")
    throw new ApplicationError("MOTION_VALIDATION_FAILED", "Motion required/decorative flags must be boolean");
  if (intent.decorative && intent.required)
    throw new ApplicationError("MOTION_POLICY_VIOLATION", "Decorative motion cannot be required");
}

export function validateResolvedMotion(motion: ResolvedMotion): void {
  stableId(motion.motionId, "motionId");
  validateMotionTarget(motion.target);
  oneOf(motion.trigger, MOTION_TRIGGERS, "motion trigger");
  const definition = getApprovedMotionPrimitive(motion.primitive);
  if (!definition.triggers.includes(motion.trigger))
    throw new ApplicationError(
      "MOTION_UNSUPPORTED",
      `Primitive '${motion.primitive}' does not support trigger '${motion.trigger}'`,
    );
  assertToken(motion.durationToken, MOTION_DURATION_TOKENS, "duration token");
  assertToken(motion.easingToken, MOTION_EASING_TOKENS, "easing token");
  if (motion.distanceToken !== undefined)
    assertToken(motion.distanceToken, MOTION_DISTANCE_TOKENS, "distance token");
  if (motion.staggerToken !== undefined)
    assertToken(motion.staggerToken, MOTION_STAGGER_TOKENS, "stagger token");
  oneOf(motion.reducedMotionBehavior, REDUCED_MOTION_BEHAVIORS, "reduced motion behavior");
  oneOf(motion.implementationKind, MOTION_IMPLEMENTATION_KINDS, "implementation kind");
  if (motion.implementationKind !== definition.implementationKind)
    throw new ApplicationError("MOTION_UNSUPPORTED", "Resolved implementation kind does not match primitive");
}

export function createResolvedMotionPlan(input: {
  readonly version?: number;
  readonly policy: MotionPolicy;
  readonly capability?: MotionCapability;
  readonly motions: readonly ResolvedMotion[];
}): ResolvedMotionPlan {
  if (!Number.isInteger(input.version ?? 1) || (input.version ?? 1) < 1)
    throw new ApplicationError("MOTION_VALIDATION_FAILED", "Motion plan version must be a positive integer");
  validateMotionPolicy(input.policy);
  const motions = input.motions.map((motion) => {
    const normalized: ResolvedMotion = {
      motionId: stableId(motion.motionId, "motionId"),
      target: cloneTarget(motion.target),
      trigger: motion.trigger,
      primitive: motion.primitive,
      durationToken: motion.durationToken,
      easingToken: motion.easingToken,
      ...(motion.distanceToken === undefined ? {} : { distanceToken: motion.distanceToken }),
      ...(motion.staggerToken === undefined ? {} : { staggerToken: motion.staggerToken }),
      reducedMotionBehavior: motion.reducedMotionBehavior,
      implementationKind: motion.implementationKind,
    };
    validateResolvedMotion(normalized);
    return normalized;
  });
  const ids = new Set<string>();
  for (const motion of motions)
    if (ids.has(motion.motionId))
      throw new ApplicationError("MOTION_VALIDATION_FAILED", `Duplicate motion ID '${motion.motionId}'`);
    else ids.add(motion.motionId);
  const plan: ResolvedMotionPlan = {
    version: input.version ?? 1,
    policy: input.policy,
    capability: input.capability ?? (motions.length ? "motion-basic" : "NONE"),
    motions: motions.sort((a, b) => a.motionId.localeCompare(b.motionId)),
  };
  oneOf(plan.capability, MOTION_CAPABILITIES, "motion capability");
  if (plan.policy.preset === "NONE" && plan.motions.some((motion) => motion.primitive !== "NONE"))
    throw new ApplicationError("MOTION_POLICY_VIOLATION", "NONE policy cannot contain active motion primitives");
  return deepFreeze(plan);
}

export function serializeMotionPlan(plan: ResolvedMotionPlan): string {
  validateMotionPlan(plan);
  return JSON.stringify({
    version: plan.version,
    capability: plan.capability,
    policy: {
      policyVersion: plan.policy.policyVersion,
      preset: plan.policy.preset,
      reducedMotion: plan.policy.reducedMotion,
      allowDecorativeLoops: plan.policy.allowDecorativeLoops,
      profileId: plan.policy.profileId,
    },
    motions: plan.motions.map((motion) => ({
      motionId: motion.motionId,
      target: motion.target,
      trigger: motion.trigger,
      primitive: motion.primitive,
      durationToken: motion.durationToken,
      easingToken: motion.easingToken,
      ...(motion.distanceToken === undefined ? {} : { distanceToken: motion.distanceToken }),
      ...(motion.staggerToken === undefined ? {} : { staggerToken: motion.staggerToken }),
      reducedMotionBehavior: motion.reducedMotionBehavior,
      implementationKind: motion.implementationKind,
    })),
  });
}

export function validateMotionPlan(plan: ResolvedMotionPlan): void {
  if (!Number.isInteger(plan.version) || plan.version < 1)
    throw new ApplicationError("MOTION_VALIDATION_FAILED", "Motion plan version must be a positive integer");
  validateMotionPolicy(plan.policy);
  oneOf(plan.capability, MOTION_CAPABILITIES, "motion capability");
  if (plan.policy.preset === "NONE" && plan.motions.some((motion) => motion.primitive !== "NONE"))
    throw new ApplicationError("MOTION_POLICY_VIOLATION", "NONE policy cannot contain active motion primitives");
  const ids = new Set<string>();
  for (const motion of plan.motions) {
    validateResolvedMotion(motion);
    if (ids.has(motion.motionId))
      throw new ApplicationError("MOTION_VALIDATION_FAILED", `Duplicate motion ID '${motion.motionId}'`);
    ids.add(motion.motionId);
  }
}

export function hashMotionPlan(plan: ResolvedMotionPlan): string {
  return createHash("sha256").update(serializeMotionPlan(plan), "utf8").digest("hex");
}
