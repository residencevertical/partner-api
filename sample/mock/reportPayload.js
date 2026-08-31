/**
 * MOCK ONLY (throw this file away) — a tiny stand-in for the premium report payload that
 * `GET /reports/{id}/view-data?t=…` returns under `report`.
 *
 * The real payload is the same document the PDF is rendered from: dozens of sections (location,
 * area intelligence, market intelligence, developer profile, seismic registry, building permits,
 * transport, schools, news, section narratives, warnings, quality review). It is an EVOLVING
 * document — new keys appear over time — so whatever you build on top of it must ignore what it
 * does not recognise instead of failing.
 *
 * This mock returns a handful of representative keys so the demo page has something real to
 * render, and so your own code can be exercised against the shape rather than the content.
 */
export function buildMockReportPayload(representation) {
  const { address, propertyType, reportRequestId, reportId, generatedAt, coordinates } = representation;
  const fullAddress = `${address.street} ${address.streetNumber}, ${address.city}`;

  return {
    premium_pdf_title: `Raport premium — ${fullAddress}`,
    premium_pdf_intro:
      "ACESTA ESTE UN RAPORT FALS, generat de mock-rv-api.js pentru dezvoltare locală. "
      + "Raportul real conține analiza zonei, dezvoltatorul, riscul seismic, autorizațiile de "
      + "construire, prețuri comparabile, transport, școli și semnale publice din zonă.",
    location: {
      strada: address.street,
      numar: address.streetNumber,
      localitate: address.city,
      judet: address.county,
      cod_postal: address.postalCode,
      lat: coordinates?.lat ?? null,
      lng: coordinates?.lng ?? null,
    },
    tip_proprietate: propertyType,
    section_status: {
      analiza_zona: "generated",
      evaluare_investitie: "generated",
      siguranta_infrastructura: "generated",
    },
    analiza_zona: {
      analiza: "Secțiune MOCK — în raportul real aici se află analiza detaliată a zonei.",
      puncte_forte: ["Exemplu MOCK de punct forte."],
      provocari: ["Exemplu MOCK de provocare."],
    },
    evaluare_investitie: {
      scor_general: 7,
      verdict: "Secțiune MOCK — verdictul real este scris pe baza datelor colectate pentru adresă.",
    },
    warnings: ["Raport MOCK: datele nu sunt reale și nu trebuie folosite pentru o decizie."],
    quality_review: { quality_score: 10, issues: [] },
    // Kept so anyone reading the raw JSON can tie the page back to the ledger row it came from.
    mock_metadata: { reportRequestId, reportId, generatedAt, source: "mock-rv-api.js" },
  };
}
