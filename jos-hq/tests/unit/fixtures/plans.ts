/** A complete, valid planner result as a session would return it (before coercePlan adds version). */
export function rawPlan(over: Record<string, unknown> = {}) {
  return {
    status: "planned",
    title: "Summarize Notion meeting notes",
    objective: "Summarize this week's Notion meeting notes into one page",
    success_condition: "A summary page exists in the Meetings database and lists every note from this week",
    intent_questions: [],
    identity_check: { project_root: "C:\\JOS\\Studio", email: "studio-owner@example.com", passed: true },
    connections: [{ platform: "notion", connection_key: "live::notion::default::n1", connection_name: "Studio Notion", why: "notes live in Notion" }],
    resolved_facts: [{ fact: "Meetings database id is db_123", source: "notion query-database read" }],
    steps: [
      { n: 1, kind: "read", description: "Query this week's notes", platform: "notion", action_id: "conn_mod_def::notion::query", connection_key: "live::notion::default::n1", parameters_json: '{"--path-vars":{"database_id":"db_123"}}', learned_from: "knowledge", depends_on: [], side_effect: false },
      { n: 2, kind: "write", description: "Create the summary page", platform: "notion", action_id: "conn_mod_def::notion::create-page", connection_key: "live::notion::default::n1", parameters_json: '{"-d":{"parent":{"database_id":"db_123"}}}', learned_from: "knowledge", depends_on: [1], side_effect: true },
    ],
    flow_design: { needed: false, key: "", name: "", inputs: [], outline: [], error_handling: [], test_plan: [] },
    verification: ["Read the created page back and check it lists every note"],
    risks: [],
    estimated_external_calls: 3,
    paid_surfaces: [],
    notes: "",
    ...over,
  };
}
