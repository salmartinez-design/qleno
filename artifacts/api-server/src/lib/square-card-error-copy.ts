// [card-save-truth 2026-08-20] Square's error code, said the way the office
// would say it out loud.
//
// Kept in its own file, with no database or SDK imports, so the wording can be
// unit tested. Whoever reads one of these strings is mid-call with the customer
// whose card it is, so every branch names the next action. Square's own wording
// does not: "Invalid card data." is what Maribel was shown, and it tells her
// nothing about whether to re-read the digits, ask for the zip, or ask for a
// different card.

// Square codes that mean "the card / the bank said no", as opposed to a problem
// on our side. Split out so the caller can answer 402 vs 400 truthfully.
export const SQUARE_DECLINE_CODES = new Set([
  "INVALID_CARD_DATA", "INVALID_CARD", "CARD_DECLINED", "CARD_DECLINED_VERIFICATION_REQUIRED",
  "CARD_EXPIRED", "INVALID_EXPIRATION", "INVALID_EXPIRATION_DATE", "INVALID_EXPIRATION_YEAR",
  "VERIFY_CVV_FAILURE", "VERIFY_AVS_FAILURE", "INVALID_POSTAL_CODE", "INVALID_ACCOUNT",
  "CARD_NOT_SUPPORTED", "INSUFFICIENT_FUNDS", "GENERIC_DECLINE",
]);

/**
 * Square's error code, said the way the office would say it out loud.
 *
 * Every branch names the next action, because whoever sees this is mid-call
 * with the customer whose card it is.
 */
export function explainSquareCardError(code: string | null, detail: string): string {
  switch (code) {
    case "INVALID_CARD_DATA":
    case "INVALID_CARD":
    case "INVALID_ACCOUNT":
      return "The bank did not accept this card. Read the card number, expiration and zip code back to the customer, and if it all matches, ask for a different card.";
    case "CARD_EXPIRED":
    case "INVALID_EXPIRATION":
    case "INVALID_EXPIRATION_DATE":
    case "INVALID_EXPIRATION_YEAR":
      return "The expiration date is wrong or the card has expired. Check the date on the card.";
    case "VERIFY_CVV_FAILURE":
      return "The 3 digit code on the back of the card is wrong. Ask the customer to read it again.";
    case "VERIFY_AVS_FAILURE":
    case "INVALID_POSTAL_CODE":
      return "The zip code does not match the card. Ask for the zip code on the customer's card statement.";
    case "CARD_DECLINED":
    case "CARD_DECLINED_VERIFICATION_REQUIRED":
    case "GENERIC_DECLINE":
    case "INSUFFICIENT_FUNDS":
      return "The bank turned this card down. Ask for a different card.";
    case "CARD_NOT_SUPPORTED":
      return "We cannot keep this type of card on file. Ask for a different card.";
    case "CARD_TOKEN_EXPIRED":
    case "CARD_TOKEN_USED":
      return "This card entry timed out. Close this box, open it again and re-enter the card.";
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return "Our payment account rejected the request. Tell the office to check the Square connection.";
    default:
      return String(detail).slice(0, 300);
  }
}
