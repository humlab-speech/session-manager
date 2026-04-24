const VISP_METADATA_SECTION_HEADINGS = Object.freeze({
    description: "Project description",
    financers: "Financers (Dnr)",
    ethicsReviewDnr: "Dnr from the Swedish Ethical Review Authority",
    qualityControlMethods: "Methods of quality control",
});

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

function normalizeHeadingToken(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[`*_]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeLookupToken(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[`*_]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

const HEADING_TO_KEY = new Map([
    [normalizeHeadingToken(VISP_METADATA_SECTION_HEADINGS.description), "description"],
    [normalizeHeadingToken("description"), "description"],
    [normalizeHeadingToken(VISP_METADATA_SECTION_HEADINGS.financers), "financers"],
    [normalizeHeadingToken("financers"), "financers"],
    [normalizeHeadingToken("financers dnr"), "financers"],
    [normalizeHeadingToken(VISP_METADATA_SECTION_HEADINGS.ethicsReviewDnr), "ethicsReviewDnr"],
    [normalizeHeadingToken("ethical review dnr"), "ethicsReviewDnr"],
    [normalizeHeadingToken("ethics review dnr"), "ethicsReviewDnr"],
    [normalizeHeadingToken("swedish ethical review authority dnr"), "ethicsReviewDnr"],
    [
        normalizeHeadingToken(VISP_METADATA_SECTION_HEADINGS.qualityControlMethods),
        "qualityControlMethods",
    ],
    [normalizeHeadingToken("quality control methods"), "qualityControlMethods"],
]);

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

function trimSectionLines(lines) {
    const trimmed = [...lines];
    while (trimmed.length > 0 && trimmed[0].trim() === "") {
        trimmed.shift();
    }
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === "") {
        trimmed.pop();
    }
    return trimmed;
}

function sectionLinesToText(lines) {
    return trimSectionLines(lines).join("\n").trim();
}

function parseQualityControlMethodsSection(lines) {
    const candidates = [];
    for (const line of trimSectionLines(lines)) {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
            continue;
        }
        const bulletMatch = trimmedLine.match(/^(?:[-*+]|\d+\.)\s+(.+)$/);
        const value = bulletMatch ? bulletMatch[1] : trimmedLine;
        value
            .split(/[;,]/)
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .forEach((part) => candidates.push(part));
    }

    const normalized = [];
    for (const candidate of candidates) {
        const methodId = resolveQualityControlMethodId(candidate);
        if (!methodId || normalized.includes(methodId)) {
            continue;
        }
        normalized.push(methodId);
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

function parseLegacyVispMetadataMarkdown(markdown) {
    if (typeof markdown !== "string") {
        return {
            ok: false,
            reason: "invalid_content_type",
        };
    }

    const sections = {
        description: [],
        financers: [],
        ethicsReviewDnr: [],
        qualityControlMethods: [],
    };
    const seenSections = new Set();
    let activeSectionKey = null;

    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    for (const line of lines) {
        const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
        if (headingMatch) {
            const sectionKey = HEADING_TO_KEY.get(
                normalizeHeadingToken(headingMatch[1]),
            );
            if (sectionKey) {
                activeSectionKey = sectionKey;
                seenSections.add(sectionKey);
                continue;
            }
            if (activeSectionKey) {
                sections[activeSectionKey].push(line);
            }
            continue;
        }

        if (activeSectionKey) {
            sections[activeSectionKey].push(line);
        }
    }

    const requiredSectionKeys = Object.keys(VISP_METADATA_SECTION_HEADINGS);
    const missingSections = requiredSectionKeys.filter(
        (sectionKey) => !seenSections.has(sectionKey),
    );
    if (missingSections.length > 0) {
        return {
            ok: false,
            reason: "missing_required_sections",
            missingSections,
        };
    }

    return {
        ok: true,
        metadata: normalizeProjectMetadata({
            description: sectionLinesToText(sections.description),
            financers: sectionLinesToText(sections.financers),
            ethicsReviewDnr: sectionLinesToText(sections.ethicsReviewDnr),
            qualityControlMethods: parseQualityControlMethodsSection(
                sections.qualityControlMethods,
            ),
        }),
    };
}

module.exports = {
    VISP_METADATA_SECTION_HEADINGS,
    QUALITY_CONTROL_METHOD_OPTIONS,
    QUALITY_CONTROL_METHOD_IDS,
    QUALITY_CONTROL_METHOD_LABEL_BY_ID,
    normalizeProjectMetadata,
    formatVispMetadataJson,
    parseVispMetadataJson,
    parseLegacyVispMetadataMarkdown,
};
