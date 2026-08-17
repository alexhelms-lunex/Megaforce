/**
 * The five pipeline stages.
 *
 * ===========================================================================
 * THIS LIST USED TO LIVE IN actions.ts, AND THAT ONE LINE BROKE EVERY BUTTON
 * IN THE APPLICATION.
 *
 * A "use server" file may export async functions and nothing else. Every export
 * becomes a callable server reference, so a plain array has no meaning as one --
 * Next refuses the whole module with:
 *
 *     A "use server" file can only export async functions, found object.
 *
 * It refuses it at RUNTIME, when an action is invoked. The build succeeds,
 * types pass, lint passes, and every screen renders perfectly. Then any button
 * anywhere fails, because the dock that imports this list is on every page, so
 * the invalid module sits in every page's server-action graph.
 *
 * The failure arrives as Next's redacted "An error occurred in the Server
 * Components render", which is the same sentence used for genuine server
 * crashes. Three separate rounds were spent looking for a bug in Claim, in the
 * user form, and in the role picker -- none of which had one. It was this.
 *
 * So the list lives in a plain module. actions.ts imports it like anything
 * else, and the components import it directly.
 * ===========================================================================
 */

export const STAGES = ["Lead", "Contact", "Pitch", "Quote", "Closed"] as const;

export type Stage = (typeof STAGES)[number];
