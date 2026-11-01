# Playback recovery bounds

## Classifier inputs

The classifier receives an absent source or zero to two opaque `u8` equality
IDs for each legacy queue. The proof covers every equality relation in that
bound. It does not prove arbitrary list length, JSON decoding, bytes guards,
or the filesystem observation that produced either source.

`classifies_legacy_normal_import` uses unwind 3. Equality can compare two
entries and then evaluate the loop termination condition. The third unwind is
that termination step, not an additional production entry.

## Identity inputs

The identity proof represents the current origin as normal or playlist and
represents existing, matching, and created identities as opaque `u8` values.
It proves the decision's preservation, reuse, and single-creation outcomes.
It does not prove `PlaybackState` mutation, path comparison, origin comparison,
selection of the first in-flight item, or `QueueItem` construction. The
production caller and native tests own those mappings.

## Outside this proof

Kani does not model file replacement, lock acquisition, crash interruption,
service publication, or OS scheduling here. The real-process recovery and
native service tests remain the authority for persistence, locks, and
publication ordering.
