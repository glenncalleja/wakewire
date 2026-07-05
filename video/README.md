# WakeWire demo video (Remotion)

A ~29s launch/demo clip. Not part of the published npm package.

```bash
cd video
npm install
npm run studio     # live-edit in Remotion Studio
npm run render     # -> out/wakewire-demo.mp4 (1920x1080, 30fps)
```

Scenes (`src/scenes.tsx`): polling pain → title → live email-triage stream →
sources + guarantees → install card. Composition & timing in
`src/WakeWireDemo.tsx`.
