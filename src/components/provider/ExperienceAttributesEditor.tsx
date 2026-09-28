"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ATTRIBUTE_TYPES,
  ATTRIBUTE_TYPE_LABELS,
  DIETARY_ATTRIBUTE_TAGS,
  SUGGESTED_ATTRIBUTE_VALUES,
  normalizeAttributeValue,
  type AttributeType,
} from "@/lib/provider/experience-attribute-options";
import { toggleExperienceAttribute } from "@/lib/provider/experience-actions";

type Attribute = { type: AttributeType; value: string };

/**
 * Stage 3: soft-matching tag editor (0002's experience_attributes). Every
 * type except "dietary" is a free-text signal only ever read by
 * soft-rank.ts's AI ranking — suggested chips plus a free custom-value
 * input. "dietary" is deliberately restricted to the exact four tags
 * satisfiesDietaryRequirements (filters.ts) actually matches against a
 * guest's hard requirement — see experience-attribute-options.ts's own
 * comment on why free text isn't offered there.
 */
export function ExperienceAttributesEditor({
  experienceId,
  attributes,
}: {
  experienceId: string;
  attributes: Attribute[];
}) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});

  const selected = new Set(attributes.map((a) => `${a.type}:${a.value}`));

  async function handleToggle(type: AttributeType, value: string, enabled: boolean) {
    const key = `${type}:${value}`;
    setBusyKey(key);
    setError(null);
    const result = await toggleExperienceAttribute(experienceId, type, value, enabled);
    setBusyKey(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  async function handleAddCustom(type: Exclude<AttributeType, "dietary">) {
    const raw = customInputs[type] ?? "";
    const value = normalizeAttributeValue(raw);
    if (!value) return;
    setCustomInputs((prev) => ({ ...prev, [type]: "" }));
    await handleToggle(type, value, true);
  }

  return (
    <div className="flex flex-col gap-5">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {ATTRIBUTE_TYPES.map((type) => {
        const options: { value: string; label: string }[] =
          type === "dietary"
            ? DIETARY_ATTRIBUTE_TAGS
            : SUGGESTED_ATTRIBUTE_VALUES[type].map((value) => ({ value, label: value.replace(/-/g, " ") }));

        // Any already-selected values not in the suggested list (custom tags added earlier) — still shown so they can be removed.
        const customSelected = attributes
          .filter((a) => a.type === type && !options.some((o) => o.value === a.value))
          .map((a) => ({ value: a.value, label: a.value.replace(/-/g, " ") }));

        return (
          <div key={type} className="flex flex-col gap-2">
            <p className="text-sm font-medium text-navy-700">{ATTRIBUTE_TYPE_LABELS[type]}</p>
            <div className="flex flex-wrap gap-2">
              {[...options, ...customSelected].map((option) => {
                const key = `${type}:${option.value}`;
                const isSelected = selected.has(key);
                const isBusy = busyKey === key;
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleToggle(type, option.value, !isSelected)}
                    className={`rounded-full border px-3 py-1.5 text-sm font-medium capitalize transition-colors disabled:opacity-40 ${
                      isSelected
                        ? "border-sky-500 bg-sky-100 text-sky-700"
                        : "border-ivory-400 bg-ivory-50 text-navy-600 hover:border-sky-300"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {type !== "dietary" ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={customInputs[type] ?? ""}
                  onChange={(e) => setCustomInputs((prev) => ({ ...prev, [type]: e.target.value }))}
                  placeholder="Add a custom tag…"
                  className="h-9 w-48 rounded-lg border border-ivory-400 bg-ivory-50 px-3 text-sm text-navy-900 outline-none focus:border-sky-500"
                />
                <button
                  type="button"
                  onClick={() => handleAddCustom(type as Exclude<AttributeType, "dietary">)}
                  className="text-sm font-medium text-sky-600 hover:text-sky-700"
                >
                  Add
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
