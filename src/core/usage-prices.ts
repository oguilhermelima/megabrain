// What a million tokens cost per model, to estimate spend from the token counts agents log. These
// are list prices for the API; a subscription is billed differently, so the figure is an estimate
// of the API price of the same work, never a bill. A model this table does not name has no cost:
// its tokens are reported as unpriced rather than guessed.

export const PRICES_AS_OF = "2026-10-06";
export const PRICE_NOTE = "An estimate at API list prices; subscriptions are billed differently. Cache writes use the 5-minute rate, reasoning the output rate.";

/** US dollars per million tokens. */
export type Price = Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
export type TokenCounts = Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }>;

// A cache read is a tenth of the input price and a 5-minute cache write a quarter more, unless the
// model's own price says otherwise. First match wins, so a specific family comes before a broad one.
function anthropic(input: number, output: number, cacheRead = input / 10): Price {
  return { input, output, cacheRead, cacheWrite: input * 1.25 };
}

const PRICES: ReadonlyArray<Readonly<{ match: RegExp; price: Price }>> = [
  { match: /^claude-(fable|mythos)-5-1/, price: anthropic(10, 50, 0.25) },
  { match: /^claude-(fable|mythos)-5/, price: anthropic(10, 50) },
  { match: /^claude-opus-5-5/, price: anthropic(4, 20, 0.2) },
  { match: /^claude-opus-(5|4-[5-8])/, price: anthropic(5, 25) },
  { match: /^claude-opus-4/, price: anthropic(15, 75) },
  { match: /^claude-sonnet-5/, price: anthropic(2, 10, 0.2) },
  { match: /^claude-sonnet-4/, price: anthropic(3, 15) },
  { match: /^claude-haiku-5-5/, price: anthropic(0.1, 0.5) },
  { match: /^claude-haiku-4-5/, price: anthropic(1, 5) },
];

export function priceOf(model: string): Price | null {
  return PRICES.find((entry) => entry.match.test(model))?.price ?? null;
}

/** Dollars for these tokens on this model; null when the model has no price. */
export function costOf(model: string, tokens: TokenCounts): number | null {
  const price = priceOf(model);
  if (price === null) return null;
  return (tokens.input * price.input + (tokens.output + tokens.reasoning) * price.output + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * price.cacheWrite) / 1_000_000;
}
