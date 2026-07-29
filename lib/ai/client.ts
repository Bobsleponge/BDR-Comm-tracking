import 'server-only';

export function isAiEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

export interface ChatJsonOptions {
  system: string;
  user: string;
  /** JSON schema name for response_format */
  schemaName?: string;
}

/**
 * Call OpenAI chat completions and parse JSON response.
 * Returns null when API key is missing or the call fails.
 */
export async function chatJson<T>(options: ChatJsonOptions): Promise<T | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[ai/client] OpenAI error:', res.status, errText.slice(0, 500));
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as T;
  } catch (err) {
    console.error('[ai/client] request failed:', err);
    return null;
  }
}
