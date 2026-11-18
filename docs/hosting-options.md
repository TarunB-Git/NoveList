# Hosting choices for NoveList

Provider terms checked October 8, 2026. These are deployment options; the application currently uses local SQLite, local cover files, and a NumPy/FAISS index with a PyTorch sentence encoder. Postgres and external object storage are migration work, not existing integrations.

| Option | Cost and persistence | Fit for this repository |
| --- | --- | --- |
| Oracle A1 Always Free | Eligible compute and boot storage within the account allowances; capacity may be unavailable. | Closest fit for the current disk-based app. Use the [retry tool](oracle-vm.md), then validate the ARM64 image and configure HTTPS/backups. |
| Existing Heroku Eco subscription + free Neon database | Eco is $5/month per account, shared across apps; Neon Free currently includes 1 GB Postgres per project and 100 CU-hours/month. | Can avoid an additional subscription, but requires a Postgres migration, persistent index/cover storage, and proof that the app fits an Eco dyno. |
| Heroku Eco + shared existing Heroku Postgres | No new add-on if the existing database can safely hold another application's data. | Requires a separate NoveList schema, capacity/connection checks, database migration, and the same memory/storage work. Sharing also couples failure and backup recovery with the portfolio. |
| Northflank Sandbox | Advertises two free services, one free database, and two cron jobs. | Worth a feasibility check. Confirm actual service memory and persistence allowances in the account before choosing it; model fit has not been verified. |

Sources: [Oracle allowances](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [Heroku Eco](https://devcenter.heroku.com/articles/eco-dyno-hours), [Neon Free](https://neon.com/blog/neon-free-plan-1-gb-per-project), [Northflank pricing](https://northflank.com/pricing).

## Using existing Heroku student credit

Eco supplies one account-wide pool of **1,000 dyno hours/month** for $5, shared by multiple apps. Idle web dynos sleep after 30 minutes. Two continuously awake apps can exhaust that pool, so this is appropriate for an occasional portfolio demo rather than an always-on guarantee. Eco has **512 MB RAM**, and dyno files disappear on replacement/restart. SQLite databases and a mutable index cannot be treated as durable there. [Eco hours](https://devcenter.heroku.com/articles/eco-dyno-hours), [dyno sizes](https://devcenter.heroku.com/articles/dyno-sizes), [filesystem](https://devcenter.heroku.com/articles/dyno-isolation).

Heroku Essential-0 Postgres costs **$5/month**, with 1 GB storage and 20 connections. A displayed rate near $0.007/hour is consistent with that price, but confirm the plan name under the app's **Resources** tab. Student credit is **$13/month for 24 months**, applied account-wide without rollover; it does not cover third-party add-ons. [Pricing](https://www.heroku.com/pricing/), [student credit](https://help.heroku.com/Z3RHNRHD/how-does-the-heroku-for-github-students-program-work).

Assuming the portfolio uses Eco plus Essential-0 and no other billable services:

| Arrangement | Gross monthly Heroku cost | Within $13 credit? |
| --- | --- | --- |
| Existing Eco + existing Postgres + NoveList on the same Eco subscription with Neon Free | $10 | Yes, while credit is active and free quotas suffice. |
| Existing Eco + existing Postgres shared with NoveList | $10 | Yes, subject to database capacity and isolation. |
| Existing Eco + existing Postgres + an additional Essential-0 database | $15 | No; approximately $2/month remains. |

Prefer a separate free database for NoveList over coupling it to the portfolio's database. [Heroku supports sharing a Postgres add-on](https://devcenter.heroku.com/articles/heroku-postgresql#sharing-heroku-postgres-between-applications), but NoveList's generic account table names need isolation before attaching it. Keep NoveList in its own app and repository and link a subdomain from the portfolio.

## Work needed before a Heroku migration

1. Start the production image with a 512 MB container memory limit. Measure startup, index loading, search, and collection activity with a representative catalogue; leave headroom for simultaneous requests. The current encoder's fit is unverified. If it fails, evaluate a smaller inference runtime or client-side encoding before committing to Eco.
2. Add a Postgres storage implementation for catalogue, accounts, sessions, reading library, and community data. Preserve passwords and IDs through a tested import and verify authentication, tier placement, search filters, and guest preview.
3. Make the search index reproducible from the persistent catalogue, or store vectors in the database. Move covers to suitable persistent object storage within its free quotas and content rights. No mutable state should depend on Heroku's filesystem.
4. Test migration and restore against a separate database. Deploy to a separate app only after memory, persistence, and restore checks pass. Keep the original backup and a rollback procedure.

This migration has not been performed. The [existing Render procedure](deployment.md) uses a paid disk-backed service; Oracle can retain the current disk-based architecture without that recurring hosting charge if capacity is available.
