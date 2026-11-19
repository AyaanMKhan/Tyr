// A node:test reporter for CI: every failing test becomes a GitHub Actions
// error annotation (`::error file=…,line=…,title=…::message`), so a failure
// shows up on the run's summary page and through the public check-runs API,
// without anyone downloading the logs. Used next to the spec reporter by
// `npm run test:ci`; outside GitHub Actions the lines are just text.

function escapeData(text) {
    return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text) {
    return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function describe(error) {
    if (error === undefined || error === null) return "failed";
    // node:test wraps the assertion in a "test failed" error; the cause is the useful part.
    const inner = error.cause ?? error;
    const message = inner.message ?? String(inner);
    const diff =
        inner.actual !== undefined && inner.expected !== undefined
            ? `\nactual: ${JSON.stringify(inner.actual)}\nexpected: ${JSON.stringify(inner.expected)}`
            : "";
    return `${message}${diff}`.slice(0, 4000);
}

export default async function* githubAnnotations(source) {
    for await (const event of source) {
        if (event.type !== "test:fail") continue;
        const data = event.data;
        // A suite fails when a child does; the child's own annotation says why.
        if (data.details?.type === "suite") continue;
        const props = [];
        if (data.file) props.push(`file=${escapeProperty(data.file)}`);
        if (data.line) props.push(`line=${data.line}`);
        props.push(`title=${escapeProperty(data.name)}`);
        yield `::error ${props.join(",")}::${escapeData(describe(data.details?.error))}\n`;
    }
}
