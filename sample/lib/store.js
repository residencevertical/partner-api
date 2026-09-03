/**
 * The partner's own lead store — an in-memory stand-in for YOUR database table.
 *
 * This is the one piece of state a referral integration genuinely needs: the mapping between
 * your lead and the checkout link you minted for it, plus the referral row that link eventually
 * produced. Keep it in a real table; everything else (the ledger cache, the wire log) can be
 * thrown away on restart, this cannot.
 *
 * RECOMMENDED COLUMNS (this file models exactly these)
 * ---------------------------------------------------
 *   lead_id              PK   your own id. Sent as `externalReference` when the link is minted,
 *                             so every referral row that comes back correlates without a join.
 *   checkout_link_id     uniq the `pcl_…` token from the 201 mint response.
 *   checkout_url              the `/c/<token>` URL you put behind the button. Reusable until
 *                             `checkout_expires_at`; mint a fresh one when a lead re-engages
 *                             after that.
 *   checkout_expires_at       when the link stops working (you chose it: `expiresInHours`).
 *   referral_id               our id for the conversion, from `GET /referrals`. NULL until the
 *                             lead buys.
 *   referral_status           pending | earned | void — copied from the ledger on every poll.
 *                             `earned` + `paid_at` set = the commission is in your bank.
 *   commission_cents          your commission on this conversion, snapshotted by us.
 *   earned_at / paid_at       timestamps as returned by us.
 *   last_request_id           the last `X-RV-Request-Id` → what support asks for
 *
 * Index `checkout_link_id` (ledger rows carry it too) and `referral_status` (the "still pending"
 * sweeper that polls the ledger).
 */

export function createLeadStore() {
  const leads = new Map();
  const byCheckoutLinkId = new Map();

  return {
    create({ leadId, property }) {
      const lead = {
        leadId,
        property,
        checkoutLinkId: null,
        checkoutUrl: null,
        checkoutExpiresAt: null,
        createdAt: new Date().toISOString(),
        referral: null, // the ledger row for this lead, once it converts
        lastRequestId: null,
        error: null,
      };
      leads.set(leadId, lead);
      return lead;
    },

    get: (leadId) => leads.get(leadId),
    getByCheckoutLinkId: (checkoutLinkId) => byCheckoutLinkId.get(checkoutLinkId),
    all: () => [...leads.values()],

    /** The 201 mint response, stored next to the lead — the URL goes behind your button. */
    attachCheckoutLink(lead, link) {
      lead.checkoutLinkId = link.checkoutLinkId;
      lead.checkoutUrl = link.url;
      lead.checkoutExpiresAt = link.expiresAt;
      lead.error = null;
      byCheckoutLinkId.set(link.checkoutLinkId, lead);
      return lead;
    },

    /** Is the stored link still usable? Past expiry, mint a fresh one rather than serving a dead URL. */
    hasLiveCheckoutLink: (lead) => Boolean(lead.checkoutUrl) && Date.parse(lead.checkoutExpiresAt) > Date.now(),

    /**
     * Apply one ledger row (from `GET /referrals`) to the lead it belongs to. The ledger is the
     * system of record: a later poll always overwrites what an earlier one stored, so a
     * `pending` that becomes `earned` — or `void` — is picked up on the next pass.
     */
    applyReferral(lead, referral) {
      if (!lead || !referral) return null;
      lead.referral = {
        referralId: referral.referralId,
        status: referral.status,
        commissionCents: referral.commissionCents,
        createdAt: referral.createdAt,
        earnedAt: referral.earnedAt ?? null,
        paidAt: referral.paidAt ?? null,
      };
      return lead;
    },

    /**
     * Correlate a whole ledger page with your leads: by YOUR lead id (`externalReference`) first,
     * by the link that attributed the purchase (`checkoutLinkId`) as a fallback. Both are copied
     * from the checkout link at attribution time, so either one is enough.
     */
    applyLedger(rows) {
      let matched = 0;
      for (const referral of rows ?? []) {
        const lead = (referral.externalReference && leads.get(referral.externalReference))
          ?? (referral.checkoutLinkId && byCheckoutLinkId.get(referral.checkoutLinkId));
        if (lead) {
          this.applyReferral(lead, referral);
          matched += 1;
        }
      }
      return matched;
    },

    markMintFailed(lead, error) {
      lead.error = { code: error.code, message: error.message, requestId: error.requestId };
      lead.lastRequestId = error.requestId ?? lead.lastRequestId;
      return lead;
    },
  };
}
