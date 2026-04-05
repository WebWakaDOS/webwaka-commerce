// AI narrative helper — routes through webwaka-ai-platform
// Replaces the former direct OpenRouter call.
// AI_PLATFORM_URL + AI_PLATFORM_TOKEN are set as Worker secrets.

export interface AIPlatformNarrativeEnv {
  AI_PLATFORM_URL?: string;
  AI_PLATFORM_TOKEN?: string;
}

/**
 * Generate a plain-English inventory alert narrative via webwaka-ai-platform.
 * Non-fatal — returns undefined if the platform is unconfigured or errors.
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
  }
): Promise<string | undefined> {
  if (!env.AI_PLATFORM_URL || !env.AI_PLATFORM_TOKEN) return undefined;

  const prompt = `You are a Nigerian inventory analyst writing a concise alert (max 2 sentences).
Product: "${forecast.productName}" (SKU: ${forecast.sku})
Current stock: ${forecast.currentStock} units
Avg daily sales: ${forecast.avgDailySales.toFixed(1)} units/day
Estimated runout: ${forecast.estimatedRunoutDays} days (${forecast.estimatedRunoutDate})
Urgency: ${forecast.urgency}
Recommend ordering: ${forecast.recommendedOrderQty} units
Write a concise plain-English alert for the store owner.`;

  try {
    const res = await fetch(`${env.AI_PLATFORM_URL}/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.AI_PLATFORM_TOKEN}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        max_tokens: 128,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content?.trim();
  } catch {
    return undefined;
  }
}

