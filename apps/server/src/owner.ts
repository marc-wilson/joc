// Who a request acts for. Every stored record belongs to one owner, and every store function
// takes an Owner first, so data can't be read or written without one.

declare const brand: unique symbol;

/** An owner id the auth layer resolved for a request. Only `ownerFrom` makes one. */
export type Owner = string & { readonly [brand]: true };

/** Owner ids are server-made and never contain `/`, so a key's owner part can't be forged. */
export function ownerFrom(id: string): Owner {
  if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid owner id: ${id}`);
  return id as Owner;
}

/** A session's key: the owner first, so another owner's report can't land on it. */
export const sessionKey = (owner: Owner, sessionId: string) => `${owner}/${sessionId}`;
