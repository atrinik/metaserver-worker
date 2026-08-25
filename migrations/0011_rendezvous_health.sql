-- One bounded, privacy-safe observation row feeds the private Observatory
-- handoff. It contains only aggregate counters, timestamps, and an operator
-- canary result. It never stores a server identity, room/connection ID,
-- ticket, candidate, credential, or source address.
CREATE TABLE rendezvous_health_observations (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    observation_generation INTEGER NOT NULL CHECK (
        typeof(observation_generation) = 'integer' AND
        observation_generation BETWEEN 1 AND 9007199254740991
    ),
    window_started_at INTEGER NOT NULL CHECK (
        typeof(window_started_at) = 'integer' AND
        window_started_at BETWEEN 0 AND 9007199254740991
    ),
    source_timestamp INTEGER NOT NULL CHECK (
        typeof(source_timestamp) = 'integer' AND
        source_timestamp BETWEEN 0 AND 9007199254740991
    ),
    authenticated_admissions INTEGER NOT NULL CHECK (
        typeof(authenticated_admissions) = 'integer' AND
        authenticated_admissions BETWEEN 0 AND 1000000
    ),
    session_completed INTEGER NOT NULL CHECK (
        typeof(session_completed) = 'integer' AND
        session_completed BETWEEN 0 AND 1000000
    ),
    session_client_disconnected INTEGER NOT NULL CHECK (
        typeof(session_client_disconnected) = 'integer' AND
        session_client_disconnected BETWEEN 0 AND 1000000
    ),
    session_expired INTEGER NOT NULL CHECK (
        typeof(session_expired) = 'integer' AND
        session_expired BETWEEN 0 AND 1000000
    ),
    session_protocol_error INTEGER NOT NULL CHECK (
        typeof(session_protocol_error) = 'integer' AND
        session_protocol_error BETWEEN 0 AND 1000000
    ),
    session_server_unavailable INTEGER NOT NULL CHECK (
        typeof(session_server_unavailable) = 'integer' AND
        session_server_unavailable BETWEEN 0 AND 1000000
    ),
    session_server_replaced INTEGER NOT NULL CHECK (
        typeof(session_server_replaced) = 'integer' AND
        session_server_replaced BETWEEN 0 AND 1000000
    ),
    session_authorization_failed INTEGER NOT NULL CHECK (
        typeof(session_authorization_failed) = 'integer' AND
        session_authorization_failed BETWEEN 0 AND 1000000
    ),
    session_internal_error INTEGER NOT NULL CHECK (
        typeof(session_internal_error) = 'integer' AND
        session_internal_error BETWEEN 0 AND 1000000
    ),
    canary_type TEXT NOT NULL CHECK (
        canary_type IN ('none', 'route', 'end_to_end')
    ),
    canary_route TEXT NOT NULL CHECK (
        canary_route IN ('not_observed', 'reachable', 'failed')
    ),
    canary_authenticated_control TEXT NOT NULL CHECK (
        canary_authenticated_control IN ('not_observed', 'passed', 'failed')
    ),
    canary_recent_admission TEXT NOT NULL CHECK (
        canary_recent_admission IN ('not_observed', 'passed', 'failed')
    ),
    canary_observed_at INTEGER NOT NULL CHECK (
        typeof(canary_observed_at) = 'integer' AND
        canary_observed_at BETWEEN 0 AND 9007199254740991
    ),
    CHECK (
        (
            canary_type = 'none' AND
            canary_route = 'not_observed' AND
            canary_authenticated_control = 'not_observed' AND
            canary_recent_admission = 'not_observed' AND
            canary_observed_at = 0
        ) OR (
            canary_type = 'route' AND
            canary_route IN ('reachable', 'failed') AND
            canary_authenticated_control = 'not_observed' AND
            canary_recent_admission = 'not_observed' AND
            canary_observed_at >= 0
        ) OR (
            canary_type = 'end_to_end' AND
            canary_route IN ('reachable', 'failed') AND
                    canary_observed_at >= 0 AND
            (
                (
                    canary_route = 'failed' AND
                    canary_authenticated_control = 'not_observed' AND
                    canary_recent_admission = 'not_observed'
                ) OR (
                    canary_route = 'reachable' AND
                    canary_authenticated_control IN ('passed', 'failed') AND
                    canary_recent_admission IN ('passed', 'failed')
                )
            )
        )
    ),
    CHECK (source_timestamp >= window_started_at)
) WITHOUT ROWID;
