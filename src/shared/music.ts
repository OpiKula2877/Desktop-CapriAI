import type { NowPlaying } from './types'

// Apps whose media session is always music – Capri dances to them without listening first.
const MUSIC_APPS =
  /spotify|applemusic|apple music|itunes|zunemusic|deezer|tidal|amazonmusic|amazon music|soundcloud|foobar|musicbee|winamp|aimp|pandora|qobuz|napster|plexamp|musicolet|dopamine|youtube ?music|ytmdesktop|music\.youtube/i

/** True when the playing source is a dedicated music app/site (dance right away). */
export function isMusicApp(np: NowPlaying | null): boolean {
  if (!np) return false
  return MUSIC_APPS.test(np.app) || /youtube music|music\.youtube|spotify/i.test(np.title)
}
