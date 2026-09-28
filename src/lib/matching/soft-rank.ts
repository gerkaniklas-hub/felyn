import { createOpenAIClient } from "@/lib/openai/client";
import type { MatchedExperience } from "./hard-filter";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Only these attribute_type values are "soft" signals the AI may reason
// about. 'dietary' is deliberately excluded — dietary compatibility is a
// hard constraint already enforced by hard-filter.ts, so the AI never even
// sees those tags, let alone gets to re-judge them.
const SOFT_ATTRIBUTE_TYPES = new Set(["atmosphere", "setting", "style", "occasion", "specialty"]);

export type StaySoftContext = {
  occasionLabels: string[];
  preferencesText: string | null;
};

export type AIPick = { id: string; reason: string };

type ExperienceSoftSummary = {
  id: string;
  title: string;
  category: string;
  cuisine: string | null;
  short_description: string | null;
  soft_attributes: { type: string; value: string }[];
};

function toSoftSummary(exp: MatchedExperience): ExperienceSoftSummary {
  return {
    id: exp.id,
    title: exp.title,
    category: exp.category,
    cuisine: exp.cuisine,
    short_description: exp.short_description,
    soft_attributes: exp.attributes
      .filter((attr) => SOFT_ATTRIBUTE_TYPES.has(attr.attribute_type))
      .map((attr) => ({ type: attr.attribute_type, value: attr.attribute_value })),
  };
}

/**
 * Asks OpenAI to rank the already hard-filtered `eligible` experiences by
 * soft fit only (occasion, free-text preferences, atmosphere/setting/style/
 * cuisine). Only soft fields are sent — no price, availability, guest
 * counts, location, or dietary data ever reaches the prompt, so the model
 * has no way to "decide" any hard constraint even if it wanted to.
 *
 * The response schema constrains `id` to an enum of the exact eligible ids,
 * so the model is structurally blocked from inventing one. The caller
 * (src/lib/matching/actions.ts) still re-validates every id against the
 * shortlist before using it — defense in depth, never trust one layer alone.
 *
 * Throws on any API/parsing failure; the caller is responsible for falling
 * back to a deterministic result.
 */
export async function rankExperiencesWithAI(
  eligible: MatchedExperience[],
  staySoftContext: StaySoftContext,
  desiredCount: number,
): Promise<AIPick[]> {
  const summaries = eligible.map(toSoftSummary);
  const eligibleIds = summaries.map((summary) => summary.id);
  const pickCount = Math.min(desiredCount, eligibleIds.length);

  const client = createOpenAIClient();
  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You rank holiday dining/drink experiences for a guest using ONLY soft, subjective fit: " +
          "occasion, the guest's free-text preferences, atmosphere, setting, style, and cuisine/specialty. " +
          "Every experience given to you has ALREADY been verified as eligible on price, group size, dates, " +
          "location and dietary needs — do not consider or re-judge any of that, and do not invent facts " +
          "about any experience beyond what is given. Choose exactly the requested number of experiences " +
          "from the provided list only, and give a short, concrete reason for each pick grounded only in " +
          "the fields provided.",
      },
      {
        role: "user",
        content: JSON.stringify({
          guest_occasion: staySoftContext.occasionLabels,
          guest_preferences_free_text: staySoftContext.preferencesText,
          number_to_pick: pickCount,
          eligible_experiences: summaries,
        }),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "experience_picks",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            picks: {
              type: "array",
              minItems: pickCount,
              maxItems: pickCount,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", enum: eligibleIds },
                  reason: { type: "string" },
                },
                required: ["id", "reason"],
              },
            },
          },
          required: ["picks"],
        },
      },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content.");

  const parsed: unknown = JSON.parse(content);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { picks?: unknown }).picks)
  ) {
    throw new Error("OpenAI response did not match the expected shape.");
  }

  return (parsed as { picks: AIPick[] }).picks;
}
