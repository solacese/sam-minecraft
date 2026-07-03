# Durable Server Runbook

## Target Experience

- Public museum website on GitHub Pages.
- Always-on Minecraft Java server at `ec2-16-54-209-252.ca-central-1.compute.amazonaws.com:25565`.
- Agent chat through scripted in-game guide agents.
- Public build requests through a queue, not direct world mutation.
- A baseline museum world with Munich Famous Building, Eiffel Tower, Sydney Opera House, Architecture Tower, Colosseum, and Neuschwanstein Castle.

## Recommended AWS v1 Shape

- EC2 `t4g.xlarge` in `us-east-1` for Minecraft, SAM, MCP bots, reverse proxy, and queue worker.
- Encrypted gp3 EBS volume mounted for Minecraft world data and SAM runtime state.
- Elastic IP for stable Minecraft DNS.
- Security group allows `443`, `25565`, and SSH only from an admin IP.
- SSM Parameter Store or Secrets Manager for model/API credentials.
- CloudWatch logs and alarms for disk, process health, queue failures, and high request volume.
- Daily EBS snapshots and a named baseline snapshot after the museum is seeded.

## Public Request Flow

1. Visitor submits a model request from GitHub Pages.
2. Static site posts to API Gateway when `request.apiEndpoint` is configured.
3. Lambda validates and rate-limits the request.
4. DynamoDB stores request state.
5. SQS queues approved/curated jobs.
6. The EC2 queue worker runs one trusted build at a time.
7. Public guide agents stay read-only; only the internal build runner can mutate Minecraft.

Until API Gateway is deployed, the site falls back to prefilled GitHub issues.

## Museum Seed Layout

| Landmark | Center |
|---|---:|
| Munich Famous Building | `0, 0` |
| Eiffel Tower | `220, 0` |
| Sydney Opera House | `0, 220` |
| Architecture Tower | `-220, 0` |
| Colosseum | `220, 220` |
| Neuschwanstein Castle | `-220, 220` |

After seeding, add paths and signs, run `save-all flush`, stop mutating agents, and create the baseline EBS snapshot.

## Launch Checklist

- Rotate any credentials that were shared in chat or docs.
- Set production DNS names in `docs/data/museum.json`.
- Add the six public YouTube links to `docs/data/museum.json`.
- Enable GitHub Pages from the `docs/` folder.
- Deploy EC2, EBS, security group, IAM role, and DNS.
- Move secrets into SSM or Secrets Manager.
- Start Minecraft/SAM under systemd.
- Seed the museum world and create the baseline snapshot.
- Test website, chat, Minecraft join, request fallback, and server reboot recovery.

## Cost Planning

Use `t4g.xlarge` for the public-builder version. Expected AWS infrastructure cost is roughly `$125-165/month` before LLM usage, mostly EC2, EBS, snapshots, logs, and public IPv4.
