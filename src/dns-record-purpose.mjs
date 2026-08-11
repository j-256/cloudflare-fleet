import { normalizeText } from "./normalize.mjs"

export const TXT_RECORD_PURPOSE = Object.freeze({
  SPF: "spf",
  DMARC: "dmarc",
  DKIM: "dkim",
  MTA_STS: "mta-sts",
  TLS_REPORTING: "tls-reporting",
  BIMI: "bimi",
  VERIFICATION: "verification",
  OTHER: "other",
})

export const TXT_RECORD_PURPOSE_ORDER = Object.freeze([
  TXT_RECORD_PURPOSE.SPF,
  TXT_RECORD_PURPOSE.DMARC,
  TXT_RECORD_PURPOSE.DKIM,
  TXT_RECORD_PURPOSE.MTA_STS,
  TXT_RECORD_PURPOSE.TLS_REPORTING,
  TXT_RECORD_PURPOSE.BIMI,
  TXT_RECORD_PURPOSE.VERIFICATION,
  TXT_RECORD_PURPOSE.OTHER,
])

export const TXT_RECORD_PURPOSE_PRESENTATION = Object.freeze({
  [TXT_RECORD_PURPOSE.SPF]: Object.freeze({ label: "SPF" }),
  [TXT_RECORD_PURPOSE.DMARC]: Object.freeze({ label: "DMARC" }),
  [TXT_RECORD_PURPOSE.DKIM]: Object.freeze({ label: "DKIM" }),
  [TXT_RECORD_PURPOSE.MTA_STS]: Object.freeze({ label: "MTA-STS" }),
  [TXT_RECORD_PURPOSE.TLS_REPORTING]: Object.freeze({ label: "TLS reporting" }),
  [TXT_RECORD_PURPOSE.BIMI]: Object.freeze({ label: "BIMI" }),
  [TXT_RECORD_PURPOSE.VERIFICATION]: Object.freeze({ label: "Domain verification" }),
  [TXT_RECORD_PURPOSE.OTHER]: Object.freeze({ label: "Other TXT" }),
})

const VERIFICATION_PATTERNS = Object.freeze([
  /^[a-z0-9_-]*verification[a-z0-9_-]*[:=]/,
  /^[a-z0-9_-]+-(?:domain-|site-)?verification[:=]/,
  /^amazonses[:=]/,
  /^docusign[:=]/,
  /^globalsign-domain-verification[:=]/,
  /^have-i-been-pwned-verification[:=]/,
  /^ms=/,
  /^zoom_verify_/,
])

export function txtRecordContent(record) {
  return String(record?.content || "")
    .replace(/"\s+"/g, "")
    .replace(/^"|"$/g, "")
    .trim()
}

export function txtRecordPurpose(record) {
  if (String(record?.type || "").toUpperCase() !== "TXT") return ""
  const content = txtRecordContent(record).toLowerCase()
  const owner = String(record.name || "").replace(/\.$/, "").toLowerCase()

  if (/^v=spf1(?:\s|$)/.test(content)) return TXT_RECORD_PURPOSE.SPF
  if (/^v=dmarc1(?:;|$)/.test(content) || /(^|\.)_dmarc(?:\.|$)/.test(owner)) {
    return TXT_RECORD_PURPOSE.DMARC
  }
  if (/^v=dkim1(?:;|$)/.test(content) || /(^|\.)[^.]+\._domainkey(?:\.|$)/.test(owner)) {
    return TXT_RECORD_PURPOSE.DKIM
  }
  if (/^v=stsv1(?:;|$)/.test(content) || /(^|\.)_mta-sts(?:\.|$)/.test(owner)) {
    return TXT_RECORD_PURPOSE.MTA_STS
  }
  if (/^v=tlsrptv1(?:;|$)/.test(content) || /(^|\.)_smtp\._tls(?:\.|$)/.test(owner)) {
    return TXT_RECORD_PURPOSE.TLS_REPORTING
  }
  if (/^v=bimi1(?:;|$)/.test(content) || /(^|\.)[^.]+\._bimi(?:\.|$)/.test(owner)) {
    return TXT_RECORD_PURPOSE.BIMI
  }
  if (VERIFICATION_PATTERNS.some((pattern) => pattern.test(content))) {
    return TXT_RECORD_PURPOSE.VERIFICATION
  }
  return TXT_RECORD_PURPOSE.OTHER
}

function txtRecordMarker(content) {
  const marker = content.match(/^([^:=\s]+)(?=[:=])/)?.[1]
  if (marker) return marker.toLowerCase()
  // Some providers use a delimiter-less prefix_<token> form (e.g. Zoom); group
  // by the fixed provider prefix so the per-zone token does not fragment identity
  const prefixed = content.match(/^(zoom_verify)_/i)?.[1]
  return prefixed ? prefixed.toLowerCase() : ""
}

export function txtRecordIdentity(record, zoneName) {
  const purpose = txtRecordPurpose(record)
  if (!purpose) return { key: "", label: "" }

  const label = TXT_RECORD_PURPOSE_PRESENTATION[purpose].label
  const content = txtRecordContent(record)
  if (purpose === TXT_RECORD_PURPOSE.VERIFICATION) {
    const marker = txtRecordMarker(content)
    return {
      key: marker ? `${purpose}:${marker}` : `${purpose}:${normalizeText(content, zoneName)}`,
      label: marker ? `${label}: ${marker}` : label,
    }
  }
  if (purpose === TXT_RECORD_PURPOSE.OTHER) {
    return {
      key: `${purpose}:${normalizeText(content, zoneName)}`,
      label,
    }
  }
  return { key: purpose, label }
}

export function txtRecordPurposeCounts(records) {
  const counts = {}
  for (const record of records || []) {
    const purpose = txtRecordPurpose(record)
    if (purpose) counts[purpose] = (counts[purpose] || 0) + 1
  }
  return counts
}

export function orderedTxtRecordPurposes(purposes) {
  const values = purposes instanceof Set ? purposes : new Set(purposes || [])
  return TXT_RECORD_PURPOSE_ORDER.filter((purpose) => values.has(purpose))
}
