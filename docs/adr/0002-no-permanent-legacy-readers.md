# ADR 0002: No permanent legacy readers

- Status: Accepted

Normal MPX operation never reads legacy configuration or treats former repositories as runtime authorities.

A bounded one-time migration may read exact legacy state only when it validates provenance, preserves user data, records ownership, and fails closed on ambiguity. After migration, current configuration and receipts are the only authorities. Compatibility aliases and permanent fallback readers are not retained.
