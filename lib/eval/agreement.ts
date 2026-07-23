import type { RelevanceScore } from "./types";

export interface AgreementStats {
  count: number;
  exactAgreement: number;
  withinOneAgreement: number;
  quadraticWeightedKappa: number;
}

export function computeAgreement(
  pairs: Array<readonly [RelevanceScore, RelevanceScore]>,
): AgreementStats {
  if (pairs.length === 0) throw new Error("Agreement requires at least one paired rating.");
  const categories = 4;
  const observed = Array.from({ length: categories }, () => Array<number>(categories).fill(0));
  const firstTotals = Array<number>(categories).fill(0);
  const secondTotals = Array<number>(categories).fill(0);
  let exact = 0;
  let withinOne = 0;

  for (const [first, second] of pairs) {
    observed[first][second] += 1;
    firstTotals[first] += 1;
    secondTotals[second] += 1;
    if (first === second) exact += 1;
    if (Math.abs(first - second) <= 1) withinOne += 1;
  }

  let observedDisagreement = 0;
  let expectedDisagreement = 0;
  for (let first = 0; first < categories; first += 1) {
    for (let second = 0; second < categories; second += 1) {
      const weight = ((first - second) / (categories - 1)) ** 2;
      observedDisagreement += weight * (observed[first][second] / pairs.length);
      expectedDisagreement +=
        weight * ((firstTotals[first] * secondTotals[second]) / pairs.length ** 2);
    }
  }

  const kappa =
    expectedDisagreement === 0
      ? observedDisagreement === 0
        ? 1
        : 0
      : 1 - observedDisagreement / expectedDisagreement;
  return {
    count: pairs.length,
    exactAgreement: exact / pairs.length,
    withinOneAgreement: withinOne / pairs.length,
    quadraticWeightedKappa: kappa,
  };
}
