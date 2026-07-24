workflow({
  version: 1,
  name: "audit-routes",
  description: "Discover API routes, audit each route independently, then verify and synthesize one report.",
  size: "small",
  permissions: ["read"],
  phases: ["Discover", "Audit", "Verify"],
  maxAgents: 5,
  maxConcurrency: 3,
  timeoutMs: 900000,
  steps: [
    phase("Discover", [
      run("discover-routes", {
        agent: "pi-workbench.fast-scout",
        saveAs: "discovery",
        task: "Find every API route relevant to {{input.request}}. Return route paths and source files.",
        schema: {
          type: "object",
          required: ["routes"],
          additionalProperties: false,
          properties: {
            routes: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                required: ["path", "file"],
                additionalProperties: false,
                properties: {
                  path: { type: "string" },
                  file: { type: "string" }
                }
              }
            }
          }
        }
      })
    ]),
    phase("Audit", [
      forEach("audit-each-route", {
        from: output("discovery", "/routes"),
        as: "route",
        maxItems: 3,
        concurrency: 3,
        collectAs: "audits",
        steps: [
          run("audit-route", {
            agent: "pi-workbench.reviewer",
            saveAs: "audit",
            task: "Audit route {{route.path}} in {{route.file}} for missing authentication and authorization. Require file:line evidence.",
            schema: {
              type: "object",
              required: ["route", "findings"],
              additionalProperties: false,
              properties: {
                route: { type: "string" },
                findings: { type: "array", items: { type: "string" } }
              }
            }
          })
        ]
      })
    ]),
    phase("Verify", [
      run("verify-findings", {
        agent: "pi-workbench.reviewer",
        saveAs: "final_report",
        task: "Independently challenge these route-audit results against the source. Remove unsupported claims and return one concise evidence-backed report:\n\n{{outputs.audits}}"
      })
    ])
  ],
  result: output("final_report")
});
