import { describe, expect, it } from 'vitest'
import { isMusicApp } from '../src/shared/music'

const np = (app: string, title = 'x') => ({ app, title, artist: '', playing: true })

describe('isMusicApp', () => {
  it('recognizes music players', () => {
    expect(isMusicApp(np('Spotify.exe'))).toBe(true)
    expect(isMusicApp(np('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'))).toBe(true)
    expect(isMusicApp(np('AppleInc.AppleMusicWin_nzyj5cx40ttqa!App'))).toBe(true)
    expect(isMusicApp(np('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic'))).toBe(true)
    expect(isMusicApp(np('Brave', 'Song – YouTube Music'))).toBe(true)
  })
  it('leaves browsers and video apps to the audio classifier', () => {
    expect(isMusicApp(np('Brave', 'Minecraft video - YouTube'))).toBe(false)
    expect(isMusicApp(np('chrome'))).toBe(false)
    expect(isMusicApp(np('VLC'))).toBe(false)
    expect(isMusicApp(null)).toBe(false)
  })
})
