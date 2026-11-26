# Deployment

- Use a deployment task ticket so a worker deploys from an eligible work machine.
- When filing work that needs deployment, arrange one `open_task_ticket` with `kind: "operation"`, `repository`, `deploy: true` and `after` set to the repository's last chain for the need.
  Set defaults right away.
  The owner's single start on that chain authorizes both, and the deployment uses its final merge commit.
  If later work needs the deployed version, arrange it after the deployment ticket or use `after_deployment` on the code chain it deploys.
- The repository's `.superagent2/deployment.json` names the eligible work machines in `target`.
  Use one name for machine-local services or credentials, and a non-empty array of distinct names when each machine can run the same recipe.
  For a list of several machines, the hub derives the platform from their systems, chooses an available machine from the list, and lets the owner choose a listed machine on the card.
  If the manifest is being added and the hub cannot read it yet, state the platform the new recipe needs, using `any` for a mixed macOS and Windows list.
  The runner checks the manifest at the deployed commit.
- If the owner wants a deployment and the repository has no manifest, read the repository and file a code issue to add it.
  Ask which machines can run the deployment only if you cannot find out.
  Use JSON with the following keys, with `folder` optional, and leave credentials out.
  The health command exits with 0 only when the service answers.
  Commands can use `{commit}` wherever they need the full commit hash of the deployment checkout.

  ```json
  {
    "target": "mac-mini",
    "folder": "/Users/owner/services/example",
    "deploy": "./scripts/deploy.sh",
    "health": { "command": "curl -fsS http://127.0.0.1:8080/health", "everySeconds": 5, "withinSeconds": 120 },
    "rollback": "./scripts/rollback.sh"
  }
  ```

- The worker checks health and rolls back if the new service fails to come up.
  Its success marks the affected tickets deployed and releases dependent work.
  Guide a failed deployment as you would any failed task.
- During a Super Agent deployment the hub and brain may restart while the worker carries on.
  The report arrives when the hub is back.
