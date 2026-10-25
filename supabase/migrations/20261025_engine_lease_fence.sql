-- Fencing token for the engine lease.
-- Incremented every time ownership changes hands (fresh acquire, takeover after expiry).
-- Every worker-owned write is conditional on (lease_owner, fence, lease_until > now()).
-- Safe to run more than once. engine_worker already has select/update on engine.state.
alter table engine.state add column if not exists fence bigint not null default 0;
