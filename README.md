# Desktop CapriAI

Desktopová AI pomocnice pro Windows s osobností **Capri** – výbušného netrunner engramu z Night City.
Sedí ti na ploše, kývá hlavou do hudby, nadává ti, ale pomůže. A když ji naštveš, začne „mazat System32“.

## Funkce (v1.0.0)

- **Chat overlay** – `Alt+C` kdekoli ve Windows. Okno bez rámečku vyjede shora s glitch efektem. Streaming odpovědí, Markdown, kopírování kódu, vkládání obrázků (`Ctrl+V`, drag & drop), screenshot obrazovky jedním klikem.
- **Capri na ploše** – živá 3D postavička vykreslená ve 2D stylu (Three.js, flat shading + glitch shader). Dá se přetáhnout, klik otevře chat, pravý klik menu. `Alt+Shift+C` ji schová / ukáže.
- **Jakékoli AI** – Anthropic (výchozí `claude-haiku-5-5`), libovolné OpenAI-kompatibilní API (OpenAI, OpenRouter, Groq, Ollama, LM Studio…) nebo Google Gemini. API klíče jsou šifrované přes Windows DPAPI.
- **Přístup k PC s oprávněními** – spouštění aplikací, weby, soubory ve vybraných složkách, schránka, screenshot, přepínání oken, volitelně klikání a psaní. Každý nástroj má režim *Zakázáno / Ptát se / Sama*.
- **Capri kurzor** – před každou akcí přiletí její červený kurzor tam, kam „šahá“.
- **Volatilita 0–100 %** – na 100 % vybuchne skoro hned. Při plném vzteku nastane **meltdown**: fake okno mazání System32 / kernelu, které zmizí až po upřímné omluvě (posuzuje ji AI). Je to čistě vizuální – kód meltdownu nemá přístup k souborům ani příkazům (hlídá to test). Nouzové ukončení: `Ctrl+Alt+Shift+F12`.
- **Hudba** – pozná, co hraje (Spotify, YouTube…), z beatu zvuku systému kývá hlavou, létají kolem ní noty, občas písničku okomentuje.
- **Paměť** – pamatuje si o tobě důležité věci mezi konverzacemi (spravuješ v Nastavení).
- **Spontánní hlášky** – když se nudí, něco řekne v bublině.
- **Tray + autostart** s Windows.

## Vývoj

```bash
npm install
npm run dev        # spustí aplikaci s hot reloadem
npm test           # unit testy
npm run typecheck
npm run dist       # NSIS instalátor do dist/
```

Model: `capri-model/source/Untitled5blend.glb` se přes Blender (headless) rozdělí na hlavu a tělo s pivotem na krku
a vyrenderují se 2D assety:

```bash
npm run model
```

## Struktura

- `src/main` – Electron main: okna, zkratky, tray, AI providery (`ai/`), nástroje a oprávnění, nálada, meltdown, hudba, paměť
- `src/renderer` – stránky `overlay`, `avatar`, `settings`, `meltdown`, `cursor`
- `resources/scripts/winhelper.ps1` – Win32/WinRT pomocník (okna, kliky, „co hraje“)
- `tools/split_model.py` – Blender skript pro model a 2D assety

Hlas (text-to-speech) je připravený v `src/main/tts.ts` pro další verzi.
