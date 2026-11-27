# Hindsight modified Realm native wrapper

This is a locally modified Realm.NET 20.1.0 native wrapper and Realm Core 20.1.2, licensed under Apache-2.0 with the preserved third-party notices. It is distributed separately as `hindsight-realm-wrappers.dll`. The original NuGet `realm-wrappers.dll` is retained unchanged.

Hindsight modifications dated 2026-11-01 add `shared_realm_enable_no_conversion_policy_v1` and enforce irreversible before-first-open format, schema and GUID conversion refusal. Existing exported ABI declarations are retained. See PATCH.diff and SOURCE-PINS.json for the patch, full maintained source inventory, upstream commits, archive digests and original binary identity. The new policy header is part of the MIT-licensed Hindsight host. No upstream endorsement is implied.

Corresponding compiler and configuration sources, including generated parser sources and SHA-2, are maintained in `tools/performance/realm-no-conversion/` in the distributed Hindsight source. SDK test fixtures, private QA data and binary build caches are excluded. The SHA-2 implementation is public domain. RealmCore-THIRD-PARTY-NOTICES.txt preserves Intel, Bison parser exception, JSON and MPark notices; the original source files retain their notices.

The runtime artifact hash and policy contract are `hindsight-realm-policy.json`; its compiler/source build receipt is `hindsight-realm-build.json`. These bind the actual packaged binary rather than an earlier QA build. The standard Realm NuGet entry describes the unchanged original binary only.
