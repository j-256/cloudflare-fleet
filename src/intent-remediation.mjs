import {
  MATRIX_CAPABILITY,
  matrixRowCapabilities,
} from "./capabilities.mjs"
import { HOLE_RESOLUTION_KIND } from "./constants.mjs"
import {
  dnssecDesiredStatus,
  rowSupportsDnssecIntentCorrection,
} from "./dnssec-intent.mjs"
import {
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
  fleetIntentExpectedIsAuthored,
} from "./fleet-intent.mjs"

export const INTENT_REMEDIATION_KIND = Object.freeze({
  ALLOWANCE: "allowance",
  COMPARE_ONLY: "compare-only",
  MANUAL: "manual",
  REMEDIABLE: "remediable",
})

export const INTENT_REMEDIATION_PRESENTATION = Object.freeze({
  [INTENT_REMEDIATION_KIND.ALLOWANCE]: Object.freeze({
    label: "Allowed variation",
  }),
  [INTENT_REMEDIATION_KIND.COMPARE_ONLY]: Object.freeze({
    label: "Compare only",
  }),
  [INTENT_REMEDIATION_KIND.MANUAL]: Object.freeze({
    label: "Manual remediation",
  }),
  [INTENT_REMEDIATION_KIND.REMEDIABLE]: Object.freeze({
    label: "Remediable",
  }),
})

function rowHasEditableWorkspace(row) {
  return matrixRowCapabilities(row).includes(MATRIX_CAPABILITY.WORKSPACE_EDIT)
}

function manualRemediation(text) {
  return {
    className: INTENT_REMEDIATION_KIND.MANUAL,
    text,
  }
}

export function intentPolicyRemediation(
  row,
  expected,
  valueConstraint = FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  presenceConstraint = FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
) {
  if (!row) {
    return {
      className: INTENT_REMEDIATION_KIND.COMPARE_ONLY,
      text: "This facet is unavailable, so remediation cannot be evaluated.",
    }
  }
  const directEdit = [...row.cells.values()].some((cell) => Boolean(cell.action))
  const anyFill = [...row.missingResolutions.values()].some(
    (resolution) => resolution?.available,
  )
  const editableWorkspace = rowHasEditableWorkspace(row)
  if (presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN) {
    if (directEdit || editableWorkspace) {
      return manualRemediation("Manual remediation: remove present values through the facet editor or editable ruleset workspace. Intent will treat every present value as drift.")
    }
    return {
      className: INTENT_REMEDIATION_KIND.COMPARE_ONLY,
      text: "Compare only: intent detects unexpected presence, but this facet has no supported removal flow.",
    }
  }
  if (presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
    && valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER) {
    return {
      className: INTENT_REMEDIATION_KIND.ALLOWANCE,
      text: "Allowed variation: covered zones may omit this facet, and any present value is allowed.",
    }
  }
  if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER) {
    if (anyFill || directEdit) {
      return {
        className: INTENT_REMEDIATION_KIND.REMEDIABLE,
        text: "Remediable: any value satisfies this policy, so missing cells can use an available create or fleet-copy flow.",
      }
    }
    if (editableWorkspace) {
      return manualRemediation("Manual remediation: use the editable ruleset workspace to ensure every covered zone has a value. Intent will detect missing values, but there is no automatic create flow.")
    }
    return {
      className: INTENT_REMEDIATION_KIND.COMPARE_ONLY,
      text: "Compare only: this facet has no direct editor or create flow. Intent will still require a value in every covered zone.",
    }
  }
  if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER) {
    if (directEdit) {
      return {
        className: INTENT_REMEDIATION_KIND.REMEDIABLE,
        text: presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
          ? "Remediable: duplicate present values can be edited directly. Missing values are allowed."
          : "Partly remediable: duplicate values can be edited directly. Missing cells need a new value because copying another covered zone would violate uniqueness.",
      }
    }
    if (editableWorkspace) {
      return manualRemediation(
        presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
          ? "Manual remediation: use the editable ruleset workspace to make present covered values distinct. Missing values are allowed, but there is no automatic uniqueness action."
          : "Manual remediation: use the editable ruleset workspace to make covered values distinct. Intent will detect duplicates and missing values, but there is no automatic uniqueness action.",
      )
    }
    return {
      className: INTENT_REMEDIATION_KIND.COMPARE_ONLY,
      text: presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
        ? "Compare only: intent detects duplicate present values, but no direct editor can create a distinct replacement. Missing values are allowed."
        : "Compare only: intent detects missing and duplicate values, but no direct editor can create a distinct replacement.",
    }
  }
  if (!expected) {
    return {
      className: INTENT_REMEDIATION_KIND.COMPARE_ONLY,
      text: "Choose an expected value to see its remediation support.",
    }
  }
  if (rowSupportsDnssecIntentCorrection(row)
    && dnssecDesiredStatus(expected)) {
    return {
      className: INTENT_REMEDIATION_KIND.REMEDIABLE,
      text: "Remediable: DNSSEC status can be enabled or disabled. Cloudflare-generated key metadata remains inspection-only.",
    }
  }
  if (presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL) {
    if (directEdit) {
      return {
        className: INTENT_REMEDIATION_KIND.REMEDIABLE,
        text: "Remediable: present values can be edited directly to match intent. Missing values are allowed.",
      }
    }
    if (editableWorkspace) {
      return manualRemediation("Manual remediation: use the editable ruleset workspace to reconcile present values. Missing values are allowed, but there is no automatic whole-ruleset alignment action.")
    }
    return {
      className: INTENT_REMEDIATION_KIND.COMPARE_ONLY,
      text: "Compare only: intent detects present values that differ from the expected value, but this facet has no direct editor. Missing values are allowed.",
    }
  }
  const matchingSource = expected.resolutionCanonical !== null
    && [...row.cells.values()].some((cell) => (
      cell.resolutionCanonical === expected.resolutionCanonical
        && Boolean(cell.resolutionSource)
    ))
  const matchingHole = expected.resolutionCanonical !== null
    && [...row.missingResolutions.values()].some((resolution) => (
      resolution?.available && resolution.candidates?.some(
        (candidate) => candidate.canonical === expected.resolutionCanonical,
      )
    ))
  const productCreate = row.resolutionKind === HOLE_RESOLUTION_KIND.EMAIL_POLICY
    && !fleetIntentExpectedIsAuthored(expected)
  const matchingFill = matchingSource || matchingHole || productCreate
  if (directEdit && matchingFill) {
    return {
      className: INTENT_REMEDIATION_KIND.REMEDIABLE,
      text: "Remediable: edit present values directly or fill missing values from a matching fleet source.",
    }
  }
  if (directEdit) {
    return {
      className: INTENT_REMEDIATION_KIND.REMEDIABLE,
      text: "Partly remediable: present values can be edited directly. Missing values need a matching observed source or a product-specific create flow.",
    }
  }
  if (matchingFill) {
    return {
      className: INTENT_REMEDIATION_KIND.REMEDIABLE,
      text: "Remediable: missing values can be filled from a matching fleet source.",
    }
  }
  if (editableWorkspace) {
    return manualRemediation("Manual remediation: use the editable ruleset workspace to reconcile this facet. Intent will detect and filter drift, but there is no automatic whole-ruleset alignment action.")
  }
  return {
    className: INTENT_REMEDIATION_KIND.COMPARE_ONLY,
    text: "Compare only: this facet has no direct editor or matching fill source. Intent will still detect and filter drift.",
  }
}
