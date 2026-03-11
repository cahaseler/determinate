# JSON Schema Portability for Discriminated Union Tool Actions

## Research Date: 2026-03-11

## Goal

Find a JSON Schema structure for a discriminated union of tool actions (`{ tool: string, params: object }` where `params` varies per tool) that works across OpenAI, Anthropic, and vLLM structured output features. The `anyOf` must be at the params level (not root), with each branch using a `tool_name` const discriminant.

---

## Provider-by-Provider Findings

### OpenAI Structured Outputs

**Documentation:** https://developers.openai.com/api/docs/guides/structured-outputs/

**Supported JSON Schema subset:**
- Basic types: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`
- `properties`, `required`, `items`, `enum`, `const`, `description`
- `$ref` and `$defs` for schema reuse
- `anyOf` -- supported, but **root objects cannot use `anyOf` directly** (must be a plain `type: "object"` at root)
- `additionalProperties` -- **must be set to `false`** on every object when using strict mode

**Key restrictions:**
- Max 100 total object properties across the schema
- Max 5 levels of nesting depth
- Combined character count of property names, enum values, and const values must not exceed 15,000
- Max 500 enum values total across all properties
- All properties listed in `required` (no optional properties in strict mode; use `anyOf` with `null` type for nullable)
- `minLength`, `maxLength`, `minimum`, `maximum` -- now supported (added in late 2025 updates)
- `pattern`, `format` -- limited support

**Critical for our use case:** `anyOf` inside a nested property (like `params`) works. `const` works. `additionalProperties: false` is mandatory on every object definition. All properties must be in `required`.

### Anthropic Structured Outputs

**Documentation:** https://platform.claude.com/docs/en/build-with-claude/structured-outputs

**Availability:** Public beta (header: `anthropic-beta: structured-outputs-2025-11-13`). Works with Claude Sonnet 4.5 and Opus 4.1.

**Supported JSON Schema features:**
- All basic types: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`
- `enum`, `const`, `required`, `properties`
- `$ref` and `$defs` for schema reuse
- Nested objects
- `anyOf` -- supported (union types work, including nested)
- `additionalProperties: false` -- supported and recommended

**Key restrictions:**
- `minimum`, `maximum`, `minLength`, `maxLength` -- removed by SDK transformers (constraints converted to descriptions)
- No recursive schemas
- Complex schemas with many union types + optional parameters + nesting can cause the compiled grammar to grow disproportionately large, impacting performance
- `oneOf`, `allOf` -- not explicitly documented as supported at top level; `anyOf` is the safer choice
- SDK auto-transforms: Pydantic/Zod schemas get `additionalProperties: false` injected, unsupported constraints removed

**Critical for our use case:** `anyOf` inside a nested property works. `const` works. `additionalProperties: false` is supported. Keeping the schema relatively flat helps grammar compilation performance.

### vLLM (XGrammar Backend)

**Documentation:** https://docs.vllm.ai/en/latest/features/structured_outputs/

vLLM supports multiple structured output backends: **xgrammar** (default, fastest), **outlines**, and **guidance**. When xgrammar encounters an unsupported schema feature, it can automatically fall back to another backend (unless configured with `xgrammar:no-fallback`).

**XGrammar JSON Schema support (from dottxt comparison, xgrammar v0.1.x):**

| Feature | Status |
|---------|--------|
| `anyOf` | Supported |
| `oneOf` | Unsound (treats as `anyOf`) |
| `allOf` | Unsound |
| `const` | **Unsound** (may reject valid values) |
| `enum` | **Unsound** (may reject valid values) |
| `additionalProperties` | **Unsound** (may permit invalid properties) |
| `$ref` / `$defs` | Supported |
| Basic types | Supported |
| `properties`, `required` | Supported |

**Key concerns:**
- `const` is listed as **unsound** in xgrammar -- it compiles but may reject valid constant values
- `enum` is similarly unsound
- `additionalProperties` enforcement is unreliable
- The xgrammar team indicated (Feb 2025) they were working on "almost all features" being supported "in weeks" but current status varies by version
- vLLM's automatic fallback to outlines/guidance backends provides a safety net, as those backends have broader schema support

**Critical for our use case:** `anyOf` works in xgrammar. However, `const` and `enum` are **unsound** in xgrammar, which is a significant risk for discriminated unions. The fallback to outlines/guidance backends handles these features correctly, but adds latency. If targeting vLLM specifically, `enum` at the `tool` field level (not `const` inside each branch) may be more reliable.

---

## Compatibility Matrix

| Feature | OpenAI | Anthropic | vLLM (xgrammar) | vLLM (outlines fallback) |
|---------|--------|-----------|------------------|--------------------------|
| Root `type: "object"` | Required | Supported | Supported | Supported |
| Nested `anyOf` | Yes | Yes | Yes | Yes |
| `const` | Yes | Yes | **Unsound** | Yes |
| `enum` | Yes | Yes | **Unsound** | Yes |
| `additionalProperties: false` | **Required** | Supported | Unsound enforcement | Supported |
| `required` (all props) | **Required** | Supported | Supported | Supported |
| `$ref` / `$defs` | Yes | Yes | Yes | Yes |

---

## Recommended Portable Schema

Given the findings, the safest cross-provider schema avoids relying on `const` for discrimination (unsound in xgrammar) and instead uses `enum` with a single value as the discriminant. While `enum` is also listed as unsound in xgrammar, the automatic fallback to outlines handles it. Alternatively, we can avoid per-branch discrimination entirely and rely on the top-level `tool` field as the discriminant.

### Option A: Top-level enum discriminant only (safest for xgrammar)

This avoids `const` entirely. The top-level `tool` enum selects the action, and `params` uses `anyOf` with structurally distinct branches (different `required` properties serve as implicit discriminants):

```json
{
  "type": "object",
  "properties": {
    "tool": {
      "type": "string",
      "enum": ["approve", "reject", "escalate"]
    },
    "params": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "note": { "type": "string" }
          },
          "required": ["note"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "reason": { "type": "string" },
            "severity": { "type": "string", "enum": ["low", "medium", "high"] }
          },
          "required": ["reason", "severity"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "target_team": { "type": "string" },
            "urgency": { "type": "string", "enum": ["normal", "urgent"] }
          },
          "required": ["target_team", "urgency"],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": ["tool", "params"],
  "additionalProperties": false
}
```

**Pros:** No `const` usage, avoids xgrammar unsound behavior. Structurally distinct branches.
**Cons:** No explicit discriminant inside `params`. Requires application-level validation that `tool` value matches the correct `params` shape. The LLM may sometimes pick the wrong `anyOf` branch for a given `tool` value.

### Option B: Explicit `tool_name` const discriminant (best correctness, needs xgrammar fallback)

This is the ideal schema structure. It works perfectly on OpenAI and Anthropic. On vLLM, it requires the outlines/guidance fallback since `const` is unsound in xgrammar:

```json
{
  "type": "object",
  "properties": {
    "tool": {
      "type": "string",
      "enum": ["approve", "reject", "escalate"]
    },
    "params": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "tool_name": { "type": "string", "enum": ["approve"] },
            "note": { "type": "string" }
          },
          "required": ["tool_name", "note"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "tool_name": { "type": "string", "enum": ["reject"] },
            "reason": { "type": "string" },
            "severity": { "type": "string", "enum": ["low", "medium", "high"] }
          },
          "required": ["tool_name", "reason", "severity"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "tool_name": { "type": "string", "enum": ["escalate"] },
            "target_team": { "type": "string" },
            "urgency": { "type": "string", "enum": ["normal", "urgent"] }
          },
          "required": ["tool_name", "target_team", "urgency"],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": ["tool", "params"],
  "additionalProperties": false
}
```

**Key change from original proposal:** Uses `"enum": ["approve"]` (single-value enum) instead of `"const": "approve"` as the discriminant. Single-value `enum` is semantically identical to `const` but may have better compatibility across implementations since `enum` is a more widely-implemented keyword. Both are technically unsound in xgrammar, but `enum` triggers the vLLM fallback detection more reliably.

**Pros:** Explicit discriminant inside params. Works on OpenAI and Anthropic. vLLM falls back to outlines automatically.
**Cons:** Slight latency increase on vLLM due to fallback. Redundancy between `tool` and `params.tool_name`.

### Option C: Single-value enum discriminant with $defs (DRY version)

Uses `$defs` to avoid repeating tool name enums:

```json
{
  "$defs": {
    "approve_params": {
      "type": "object",
      "properties": {
        "tool_name": { "type": "string", "enum": ["approve"] },
        "note": { "type": "string" }
      },
      "required": ["tool_name", "note"],
      "additionalProperties": false
    },
    "reject_params": {
      "type": "object",
      "properties": {
        "tool_name": { "type": "string", "enum": ["reject"] },
        "reason": { "type": "string" },
        "severity": { "type": "string", "enum": ["low", "medium", "high"] }
      },
      "required": ["tool_name", "reason", "severity"],
      "additionalProperties": false
    },
    "escalate_params": {
      "type": "object",
      "properties": {
        "tool_name": { "type": "string", "enum": ["escalate"] },
        "target_team": { "type": "string" },
        "urgency": { "type": "string", "enum": ["normal", "urgent"] }
      },
      "required": ["tool_name", "target_team", "urgency"],
      "additionalProperties": false
    }
  },
  "type": "object",
  "properties": {
    "tool": {
      "type": "string",
      "enum": ["approve", "reject", "escalate"]
    },
    "params": {
      "anyOf": [
        { "$ref": "#/$defs/approve_params" },
        { "$ref": "#/$defs/reject_params" },
        { "$ref": "#/$defs/escalate_params" }
      ]
    }
  },
  "required": ["tool", "params"],
  "additionalProperties": false
}
```

**Pros:** Clean, DRY. `$ref`/`$defs` supported across all three providers.
**Cons:** Same xgrammar `enum` unsoundness concern as Option B.

---

## Recommendation

**Use Option B** (explicit single-value `enum` discriminant) as the default schema structure. Rationale:

1. **OpenAI:** Fully supported. `anyOf` in nested properties works. `additionalProperties: false` and all-properties-in-`required` are already mandated by OpenAI's strict mode.

2. **Anthropic:** Fully supported. `anyOf`, `enum`, and `const` all work. The schema is simple enough to avoid grammar size blowup.

3. **vLLM:** `anyOf` works natively in xgrammar. The single-value `enum` discriminant will trigger automatic fallback to the outlines backend, which handles it correctly. This adds minor latency but guarantees correctness. If latency is critical, Option A (no per-branch discriminant) avoids the fallback entirely.

**If xgrammar `enum`/`const` support improves** (the xgrammar team indicated active work on this), Option B will work natively across all backends with no fallback needed.

**Validation strategy:** Regardless of schema choice, application code should validate that `tool` matches `params.tool_name` (or the shape of `params`) after receiving the response. Schema-level constraints guarantee structure but the LLM can still produce semantically inconsistent combinations (e.g., `tool: "approve"` with `params.tool_name: "reject"`), though this is rare with well-structured schemas.

---

## Sources

- [OpenAI Structured Outputs Guide](https://developers.openai.com/api/docs/guides/structured-outputs/)
- [OpenAI Structured Outputs Introduction](https://openai.com/index/introducing-structured-outputs-in-the-api/)
- [OpenAI Community - Supported Schemas Discussion](https://community.openai.com/t/official-documentation-for-supported-schemas-for-response-format-parameter-in-calls-to-client-beta-chats-completions-parse/932422)
- [Anthropic Structured Outputs Documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic Structured Outputs - Hands-On Guide (Towards Data Science)](https://towardsdatascience.com/hands-on-with-anthropics-new-structured-output-capabilities/)
- [vLLM Structured Outputs Documentation](https://docs.vllm.ai/en/latest/features/structured_outputs/)
- [vLLM Structured Outputs v0.8.2](https://docs.vllm.ai/en/v0.8.2/features/structured_outputs.html)
- [XGrammar JSON Generation Tutorial](https://xgrammar.mlc.ai/docs/tutorials/json_generation.html)
- [XGrammar GitHub - Unsupported JSON Features (Issue #192)](https://github.com/mlc-ai/xgrammar/issues/192)
- [XGrammar GitHub - JSON Schema Limitations (Issue #104)](https://github.com/mlc-ai/xgrammar/issues/104)
- [dottxt JSON Schema Comparison (xgrammar vs others)](https://blog.dottxt.ai/json-schema-comparison.html)
- [dottxt Blog - JSON Schema Support Analysis](https://blog.dottxt.ai/dotjson-has-good-schema-support.html)
- [vLLM GitHub - xgrammar unsupported features (Issue #26421)](https://github.com/vllm-project/vllm/issues/26421)
- [Red Hat - Structured Outputs in vLLM](https://developers.redhat.com/articles/2025/06/03/structured-outputs-vllm-guiding-ai-responses)
