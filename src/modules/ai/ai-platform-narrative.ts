/**
 * WebWaka Commerce — AI Platform Narrative Helpers
 *
 * All AI enrichment calls route through webwaka-ai-platform.
 * Env vars: AI_PLATFORM_URL, AI_PLATFORM_TOKEN (Worker secrets).
 *
 * DO NOT call OpenRouter, OpenAI, or any LLM directly from this vertical.
 */

export interface AIPlatformNarrativeEnv {
  AI_PLATFORM_URL?: string;
  AI_PLATFORM_TOKEN?: string;
}

async function callAIPlatform(
  env: AIPlatformNarrativeEnv,
  prompt: string,
  maxTokens = 256,
): Promise<string | null> {
  if (!env.AI_PLATFORM_URL || !env.AI_PLATFORM_TOKEN) return null;
  try {
    const res = await fetch(`${env.AI_PLATFORM_URL}/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_PLATFORM_TOKEN}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Generate a plain-English inventory runout alert via webwaka-ai-platform.
 * Used by forecasting.ts. Non-fatal — returns undefined on any error.
 */
export async function generateForecastNarrativeViaAIPlatform(
  env: AIPlatformNarrativeEnv,
  forecast: {
    productName: string;
    sku: string;
    currentStock: number;
    avgDailySales: number;
    estimatedRunoutDays: number;
    estimatedRunoutDate: string;
    urgency: string;
    recommendedOrderQty: number;
  },
): Promise<string | undefined> {
  const prompt = `You are a Nigerian inventory analyst writing a concise alert (max 2 sentences).
Product: "${forecast.productName}" (SKU: ${forecast.sku})
Current stock: ${forecast.currentStock} units
Avg daily sales: ${forecast.avgDailySales.toFixed(1)} units/day
Estimated runout: ${forecast.estimatedRunoutDays} days (${forecast.estimatedRunoutDate})
Urgency: ${forecast.urgency}
Recommend ordering: ${forecast.recommendedOrderQty} units
Write a concise plain-English alert for the store owner.`;

  return (await callAIPlatform(env, prompt, 128)) ?? undefined;
}

/**
 * Generate short recommendation copy for each recommended product.
 * Used by recommendations.ts. Returns strings parallel to recommendedNames.
 * Non-fatal — returns [] on error.
 */
export async function generateRecommendationCopyViaAIPlatform(
  env: AIPlatformNarrativeEnv,
  seedNames: string[],
  recommendedNames: string[],
): Promise<string[]> {
  const prompt = `You are a Nigerian e-commerce copywriter.
A customer is buying: ${seedNames.join(', ')}.
Write ONE short recommendation sentence (max 12 words) for each of these items that pairs well with it:
${recommendedNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}
Respond ONLY with a JSON array of strings, one per item. No explanation.`;

  const content = await callAIPlatform(env, prompt, 256);
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
