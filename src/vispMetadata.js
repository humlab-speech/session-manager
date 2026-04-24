const QUALITY_CONTROL_METHOD_OPTIONS = Object.freeze([
    { id: "manual-review", label: "Manual review" },
    { id: "peer-review", label: "Peer review" },
    { id: "double-annotation", label: "Double annotation" },
    { id: "automated-validation", label: "Automated validation" },
    { id: "systematic-sampling", label: "Systematic sampling" },
    { id: "technical-quality-check", label: "Technical quality check" },
    { id: "perceptual-evaluation", label: "Perceptual evaluation" },
]);

const QUALITY_CONTROL_METHOD_IDS = Object.freeze(
    QUALITY_CONTROL_METHOD_OPTIONS.map((option) => option.id),
);

const QUALITY_CONTROL_METHOD_LABEL_BY_ID = Object.freeze(
    QUALITY_CONTROL_METHOD_OPTIONS.reduce((acc, option) => {
        acc[option.id] = option.label;
        return acc;
    }, {}),
);

function normalizeLookupToken(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[`*_]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

const QUALITY_CONTROL_METHOD_LOOKUP = new Map();
for (const option of QUALITY_CONTROL_METHOD_OPTIONS) {
    QUALITY_CONTROL_METHOD_LOOKUP.set(normalizeLookupToken(option.id), option.id);
    QUALITY_CONTROL_METHOD_LOOKUP.set(normalizeLookupToken(option.label), option.id);
}

function resolveQualityControlMethodId(value) {
    const key = normalizeLookupToken(value);
    if (!key) {
        return null;
    }
    return QUALITY_CONTROL_METHOD_LOOKUP.get(key) || null;
}

function normalizeStringField(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}

function normalizeProjectMetadata(metadata = {}) {
    const normalized = {
        description: normalizeStringField(metadata.description),
        financers: normalizeStringField(metadata.financers),
        ethicsReviewDnr: normalizeStringField(metadata.ethicsReviewDnr),
        qualityControlMethods: [],
    };

    let rawMethods = [];
    if (Array.isArray(metadata.qualityControlMethods)) {
        rawMethods = metadata.qualityControlMethods;
    } else if (typeof metadata.qualityControlMethods === "string") {
        rawMethods = metadata.qualityControlMethods.split(/[;,]/);
    }

    for (const rawMethod of rawMethods) {
        const methodId = resolveQualityControlMethodId(rawMethod);
        if (!methodId || normalized.qualityControlMethods.includes(methodId)) {
            continue;
        }
        normalized.qualityControlMethods.push(methodId);
    }

    return normalized;
}

function formatVispMetadataJson(metadata = {}) {
    const normalized = normalizeProjectMetadata(metadata);
    return `${JSON.stringify(normalized, null, 2)}\n`;
}

function parseVispMetadataJson(content) {
    if (typeof content !== "string") {
        return {
            ok: false,
            reason: "invalid_content_type",
        };
    }

    let parsed = null;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        return {
            ok: false,
            reason: "invalid_json",
            error: error.message,
        };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
            ok: false,
            reason: "invalid_json_structure",
        };
    }

    return {
        ok: true,
        metadata: normalizeProjectMetadata(parsed),
    };
}

module.exports = {
    QUALITY_CONTROL_METHOD_OPTIONS,
    QUALITY_CONTROL_METHOD_IDS,
    QUALITY_CONTROL_METHOD_LABEL_BY_ID,
    normalizeProjectMetadata,
    formatVispMetadataJson,
    parseVispMetadataJson,
};
