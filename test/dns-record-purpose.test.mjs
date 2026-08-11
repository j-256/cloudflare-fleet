import assert from "node:assert/strict"
import test from "node:test"

import {
  orderedTxtRecordPurposes,
  TXT_RECORD_PURPOSE,
  txtRecordContent,
  txtRecordIdentity,
  txtRecordPurpose,
  txtRecordPurposeCounts,
} from "../src/dns-record-purpose.mjs"

function txt(name, content) {
  return { content, name, type: "TXT" }
}

test("TXT purposes identify common mail policy records", () => {
  assert.equal(
    txtRecordPurpose(txt("example.com", "v=spf1 include:_spf.example.net ~all")),
    TXT_RECORD_PURPOSE.SPF,
  )
  assert.equal(
    txtRecordPurpose(txt("example.com", '"v=spf1 include:_spf.example.net " "~all"')),
    TXT_RECORD_PURPOSE.SPF,
  )
  assert.equal(
    txtRecordPurpose(txt("_dmarc.example.com", "v=DMARC1; p=reject")),
    TXT_RECORD_PURPOSE.DMARC,
  )
  assert.equal(
    txtRecordPurpose(txt("selector._domainkey.example.com", "p=base64-key")),
    TXT_RECORD_PURPOSE.DKIM,
  )
  assert.equal(
    txtRecordPurpose(txt("_mta-sts.example.com", "v=STSv1; id=20260811")),
    TXT_RECORD_PURPOSE.MTA_STS,
  )
  assert.equal(
    txtRecordPurpose(txt("_smtp._tls.example.com", "v=TLSRPTv1; rua=mailto:tls@example.com")),
    TXT_RECORD_PURPOSE.TLS_REPORTING,
  )
  assert.equal(
    txtRecordPurpose(txt("default._bimi.example.com", "v=BIMI1; l=https://example.com/logo.svg")),
    TXT_RECORD_PURPOSE.BIMI,
  )
})

test("TXT purposes separate verification and unclassified values", () => {
  assert.equal(
    txtRecordPurpose(txt("example.com", "google-site-verification=token")),
    TXT_RECORD_PURPOSE.VERIFICATION,
  )
  assert.equal(
    txtRecordPurpose(txt("example.com", "stripe-verification=token")),
    TXT_RECORD_PURPOSE.VERIFICATION,
  )
  assert.equal(
    txtRecordPurpose(txt("example.com", "sfcc_verification_zzcu=token")),
    TXT_RECORD_PURPOSE.VERIFICATION,
  )
  assert.equal(
    txtRecordPurpose(txt("example.com", "custom application value")),
    TXT_RECORD_PURPOSE.OTHER,
  )
  assert.equal(
    txtRecordPurpose({ content: "v=spf1 -all", name: "example.com", type: "CNAME" }),
    "",
  )
})

test("TXT record identities align protocols and verification providers", () => {
  assert.equal(
    txtRecordContent(txt("example.com", '"v=spf1 include:_spf.example.net " "~all"')),
    "v=spf1 include:_spf.example.net ~all",
  )
  assert.deepEqual(
    txtRecordIdentity(txt("example.com", "v=spf1 -all"), "example.com"),
    { key: TXT_RECORD_PURPOSE.SPF, label: "SPF" },
  )
  assert.deepEqual(
    txtRecordIdentity(txt("example.com", "google-site-verification=first"), "example.com"),
    {
      key: `${TXT_RECORD_PURPOSE.VERIFICATION}:google-site-verification`,
      label: "Domain verification: google-site-verification",
    },
  )
  assert.equal(
    txtRecordIdentity(
      txt("example.com", "google-site-verification=second"),
      "example.com",
    ).key,
    `${TXT_RECORD_PURPOSE.VERIFICATION}:google-site-verification`,
  )
  assert.notEqual(
    txtRecordIdentity(
      txt("example.com", "openai-domain-verification=token"),
      "example.com",
    ).key,
    `${TXT_RECORD_PURPOSE.VERIFICATION}:google-site-verification`,
  )
  assert.equal(
    txtRecordIdentity(
      txt("example.com", "custom value for example.com"),
      "example.com",
    ).key,
    `${TXT_RECORD_PURPOSE.OTHER}:custom value for {zone}`,
  )
})

test("TXT purpose counts retain stable presentation order", () => {
  const counts = txtRecordPurposeCounts([
    txt("example.com", "custom value"),
    txt("example.com", "v=spf1 -all"),
    txt("example.com", "google-site-verification=one"),
    txt("example.com", "google-site-verification=two"),
  ])

  assert.deepEqual(counts, {
    [TXT_RECORD_PURPOSE.OTHER]: 1,
    [TXT_RECORD_PURPOSE.SPF]: 1,
    [TXT_RECORD_PURPOSE.VERIFICATION]: 2,
  })
  assert.deepEqual(orderedTxtRecordPurposes(Object.keys(counts)), [
    TXT_RECORD_PURPOSE.SPF,
    TXT_RECORD_PURPOSE.VERIFICATION,
    TXT_RECORD_PURPOSE.OTHER,
  ])
})
