/**
 * The voice holder: the one seat for a voice adapter (the contract is the
 * kit's `Voice`). The voice module provides its adapter once at module start;
 * every other module only ever calls `room`, and until an adapter exists that
 * call throws `VoiceNotLoaded` naming the fix. One seat, not a list: hearing
 * is one capability with one set of models behind it, and a second provider
 * is a bug, so it says so.
 */
import {
  type RoomOptions,
  type VoiceAdapter,
  type Voice as VoiceApi,
  VoiceNotLoaded,
  type VoiceRoom,
} from '@aivi/plugin/voice';

export class Voice implements VoiceApi {
  private adapter: VoiceAdapter | null = null;
  /** Platform ids rooms have been opened under (`meet`, `discord`): the
   *  origins dreaming reviews rooms the way it reviews channels. A room
   *  stamps its sessions, so an origin only appears once its first room
   *  has spoken — nothing to configure, nothing to lie about. */
  private readonly opened = new Set<string>();

  provide(adapter: VoiceAdapter): () => void {
    if (this.adapter) throw new Error('a voice adapter is already provided; voice provides exactly one');
    this.adapter = adapter;
    return () => {
      if (this.adapter === adapter) this.adapter = null;
    };
  }

  room(options: RoomOptions): VoiceRoom {
    if (!this.adapter) throw new VoiceNotLoaded();
    this.opened.add(options.id);
    return this.adapter.room(options);
  }

  /** The origins of every room this seat ever opened. */
  origins(): string[] {
    return [...this.opened];
  }
}
