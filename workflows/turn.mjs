// A week's chat turn as a Vercel Workflow run (hosted only; locally ui/server.mjs runs the turn in-process).
// The turn can take longer than Vercel's 300 s function limit, so it runs as a series of steps, each its own
// function invocation: one slice of the turn (ui/server.mjs turnStep) that saves its state and stops in time.
// The workflow only loops; all state is in the turn file (data/jobs/<id>.turn.json), mirrored to storage.
//
// Built by `workflow build` (scripts/vercel-build.mjs) into .well-known/workflow/v1/, served by api/wf-flow.mjs.
// Steps get the app from api/wf-flow.mjs (globalThis.__hwServer), so the workflow bundle doesn't include it.

export async function weekTurn(id) {
  "use workflow";
  for (let i = 1; i <= 45; i++) if (await slice(id)) return { id, slices: i };
  return { id, slices: 45, unfinished: true }; // ui/server.mjs wraps up a turn past its own slice cap first
}

async function slice(id) {
  "use step";
  const hw = globalThis.__hwServer;
  if (!hw) throw new Error("the app isn't loaded in this function (api/wf-flow.mjs loads it)");
  return (await hw.turnStep(id)).done;
}
