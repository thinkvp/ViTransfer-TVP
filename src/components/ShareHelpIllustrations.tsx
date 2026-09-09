'use client'

/**
 * Wireframe illustrations for the share-page Help guide.
 *
 * Deliberately hand-drawn SVG rather than screenshots: a screenshot goes stale
 * the moment the layout moves, and a client's branded share page never looks
 * quite like ours anyway. The wireframes show *where* things sit, and the
 * numbered badges tie each region back to the prose beside them.
 *
 * Colours come from the theme tokens so the drawings track the app's palette.
 */

const C = {
  bg: 'hsl(var(--background))',
  card: 'hsl(var(--card))',
  muted: 'hsl(var(--muted))',
  border: 'hsl(var(--border))',
  dim: 'hsl(var(--muted-foreground))',
  fg: 'hsl(var(--foreground))',
  primary: 'hsl(var(--primary))',
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  amber: 'hsl(var(--warning))',
}

type FigureProps = {
  /** Accessible description — without it the drawing is just noise to a screen reader. */
  label: string
  viewBox?: string
  children: React.ReactNode
}

function Figure({ label, viewBox = '0 0 640 340', children }: FigureProps) {
  return (
    <svg
      viewBox={viewBox}
      role="img"
      aria-label={label}
      className="w-full h-auto max-h-[min(38dvh,300px)] rounded-lg border border-border bg-background"
      preserveAspectRatio="xMidYMid meet"
    >
      {children}
    </svg>
  )
}

/** Numbered callout badge, matching the ordered list in the prose. */
function Badge({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r="11" fill={C.primary} />
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        fontSize="12"
        fontWeight="700"
        fill="hsl(var(--primary-foreground))"
        fontFamily="system-ui, sans-serif"
      >
        {n}
      </text>
    </g>
  )
}

/** A line of "text" — a rounded bar, the usual wireframe shorthand. */
function Bar({ x, y, w, h = 6, fill = C.dim, opacity = 0.45 }: {
  x: number; y: number; w: number; h?: number; fill?: string; opacity?: number
}) {
  return <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={fill} opacity={opacity} />
}

function Label({ x, y, children, fill = C.dim, size = 11, weight = 500, anchor = 'start' as const }: {
  x: number; y: number; children: React.ReactNode; fill?: string; size?: number; weight?: number
  anchor?: 'start' | 'middle' | 'end'
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      fontWeight={weight}
      fill={fill}
      textAnchor={anchor}
      fontFamily="system-ui, sans-serif"
    >
      {children}
    </text>
  )
}

/** A dropdown control: rounded box with a caret. */
function SelectBox({ x, y, w, text, h = 22, accent = false }: {
  x: number; y: number; w: number; text: string; h?: number; accent?: boolean
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="5" fill={C.muted} stroke={accent ? C.primary : C.border} strokeWidth={accent ? 1.5 : 1} />
      <Label x={x + 8} y={y + h / 2 + 4} fill={C.fg}>{text}</Label>
      <path
        d={`M ${x + w - 16} ${y + h / 2 - 2} l 4 4 l 4 -4`}
        stroke={C.dim}
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  )
}

function Pill({ x, y, w, h = 20, text, fill, stroke, textFill }: {
  x: number; y: number; w: number; h?: number; text: string; fill: string; stroke?: string; textFill: string
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={fill} stroke={stroke} strokeWidth={stroke ? 1 : 0} />
      <Label x={x + w / 2} y={y + h / 2 + 4} anchor="middle" fill={textFill} weight={600}>{text}</Label>
    </g>
  )
}

/* ------------------------------------------------------------------ */
/* 1. Finding your way around                                          */
/* ------------------------------------------------------------------ */

export function LayoutIllustration() {
  return (
    <Figure label="The share page: a breadcrumb bar across the top, the media list down the left, the video in the middle, and the feedback panel on the right.">
      {/* Header bar */}
      <rect x="12" y="12" width="616" height="34" rx="8" fill={C.card} stroke={C.border} />
      <Label x={24} y={34}>Project:</Label>
      <SelectBox x={68} y={17} w={104} text="Autumn Ad" accent />
      <Label x={180} y={34} fill={C.border} size={13}>/</Label>
      <SelectBox x={190} y={17} w={112} text="Hero Cut" accent />
      <Label x={310} y={34} fill={C.border} size={13}>/</Label>
      <SelectBox x={320} y={17} w={74} text="v3" accent />
      {/* Help button, top right */}
      <rect x="556" y="17" width="60" height="24" rx="6" fill={C.muted} stroke={C.primary} strokeWidth="1.5" />
      <circle cx="571" cy="29" r="6" fill="none" stroke={C.primary} strokeWidth="1.5" />
      <text x="571" y="33" textAnchor="middle" fontSize="9" fontWeight="700" fill={C.primary} fontFamily="system-ui, sans-serif">?</text>
      <Label x={584} y={33} fill={C.primary} weight={600}>Help</Label>

      <Badge x={30} y={62} n={1} />
      <Badge x={594} y={62} n={2} />

      {/* Sidebar */}
      <rect x="12" y="78" width="128" height="248" rx="8" fill={C.card} stroke={C.border} />
      <Label x={24} y={98} size={10} weight={700}>FOR REVIEW</Label>
      <rect x="20" y="106" width="112" height="30" rx="5" fill={C.primary} opacity="0.18" stroke={C.primary} />
      <rect x="26" y="112" width="30" height="18" rx="3" fill={C.muted} />
      <Bar x={62} y={116} w={56} opacity={0.8} />
      <Bar x={62} y={126} w={34} h={5} />
      <rect x="20" y="142" width="112" height="30" rx="5" fill={C.muted} opacity="0.5" />
      <rect x="26" y="148" width="30" height="18" rx="3" fill={C.border} />
      <Bar x={62} y={152} w={50} />
      <Bar x={62} y={162} w={30} h={5} />
      <Label x={24} y={192} size={10} weight={700}>PHOTOS</Label>
      <rect x="20" y="200" width="112" height="26" rx="5" fill={C.muted} opacity="0.5" />
      <Bar x={28} y={210} w={62} />
      <Label x={24} y={248} size={10} weight={700}>FILES</Label>
      <rect x="20" y="256" width="112" height="26" rx="5" fill={C.muted} opacity="0.5" />
      <Bar x={28} y={266} w={70} />
      <Badge x={30} y={318} n={3} />

      {/* Video area */}
      <rect x="150" y="78" width="290" height="180" rx="8" fill={C.muted} stroke={C.border} />
      <polygon points="284,152 284,184 312,168" fill={C.dim} opacity="0.55" />
      <rect x="164" y="228" width="262" height="5" rx="2.5" fill={C.border} />
      <rect x="164" y="228" width="96" height="5" rx="2.5" fill={C.primary} />
      <circle cx="212" cy="230.5" r="3.5" fill={C.amber} />
      <circle cx="286" cy="230.5" r="3.5" fill={C.amber} />
      <circle cx="352" cy="230.5" r="3.5" fill={C.amber} />
      <Badge x={295} y={274} n={4} />

      {/* Comment panel */}
      <rect x="450" y="78" width="178" height="248" rx="8" fill={C.card} stroke={C.border} />
      <rect x="450" y="78" width="178" height="26" rx="8" fill={C.muted} />
      <Label x={462} y={95} fill={C.fg} weight={600}>Feedback</Label>
      <rect x="460" y="116" width="120" height="34" rx="7" fill={C.muted} />
      <Pill x={466} y={121} w={40} h={13} text="0:12" fill="hsl(var(--warning-visible))" stroke={C.amber} textFill={C.amber} />
      <Bar x={466} y={140} w={100} />
      <rect x="496" y="160" width="120" height="34" rx="7" fill="hsl(var(--primary-visible))" />
      <Bar x={504} y={170} w={100} opacity={0.8} />
      <Bar x={504} y={181} w={64} />
      <rect x="460" y="204" width="120" height="24" rx="7" fill={C.muted} />
      <Bar x={468} y={213} w={84} />
      <rect x="460" y="248" width="156" height="62" rx="7" fill={C.muted} stroke={C.border} />
      <Bar x={470} y={262} w={90} />
      <circle cx="556" cy="292" r="9" fill={C.border} />
      <circle cx="580" cy="292" r="9" fill={C.border} />
      <circle cx="604" cy="292" r="9" fill={C.primary} />
      <Badge x={594} y={318} n={5} />
    </Figure>
  )
}

/* ------------------------------------------------------------------ */
/* 2. Watching the video                                               */
/* ------------------------------------------------------------------ */

export function PlayerIllustration() {
  return (
    <Figure
      label="The video player: a scrub bar with amber markers for existing comments, the control row beneath it, and the keyboard shortcuts."
      viewBox="0 0 640 300"
    >
      <rect x="12" y="12" width="616" height="204" rx="8" fill={C.muted} stroke={C.border} />
      <polygon points="300,96 300,132 332,114" fill={C.dim} opacity="0.5" />

      {/* markers + scrub */}
      <rect x="28" y="176" width="584" height="6" rx="3" fill={C.border} />
      <rect x="28" y="176" width="196" height="6" rx="3" fill={C.primary} />
      <circle cx="224" cy="179" r="7" fill={C.primary} />
      <circle cx="128" cy="179" r="4.5" fill={C.amber} />
      <circle cx="300" cy="179" r="4.5" fill={C.amber} />
      <rect x="368" y="176" width="70" height="6" rx="3" fill={C.amber} opacity="0.85" />
      <circle cx="520" cy="179" r="4.5" fill={C.amber} />
      {/* Badges float clear of the scrub bar and point back at it, so the marker
          they describe stays visible underneath. */}
      <path d="M 128 145 v 26" stroke={C.primary} strokeWidth="1.2" strokeDasharray="3 3" />
      <Badge x={128} y={134} n={1} />
      <path d="M 403 145 v 26" stroke={C.primary} strokeWidth="1.2" strokeDasharray="3 3" />
      <Badge x={403} y={134} n={2} />

      {/* control row */}
      <rect x="28" y="192" width="14" height="14" rx="2" fill={C.fg} opacity="0.75" />
      <Label x={52} y={204} fill={C.fg}>0:41 / 2:18</Label>
      <rect x="470" y="190" width="46" height="18" rx="4" fill={C.card} stroke={C.border} />
      <Label x={493} y={203} anchor="middle" fill={C.fg}>1080p</Label>
      <rect x="524" y="190" width="38" height="18" rx="4" fill={C.card} stroke={C.border} />
      <Label x={543} y={203} anchor="middle" fill={C.fg}>1.0x</Label>
      <rect x="570" y="190" width="38" height="18" rx="4" fill={C.card} stroke={C.border} />
      <Label x={589} y={203} anchor="middle" fill={C.fg}>Full</Label>
      <path d="M 493 225 v -14" stroke={C.primary} strokeWidth="1.2" strokeDasharray="3 3" />
      <Badge x={493} y={236} n={3} />

      {/* keyboard row */}
      <rect x="28" y="252" width="66" height="26" rx="5" fill={C.card} stroke={C.border} />
      <Label x={61} y={269} anchor="middle" fill={C.fg} weight={600}>Space</Label>
      <Label x={104} y={269}>play / pause</Label>

      <rect x="192" y="252" width="26" height="26" rx="5" fill={C.card} stroke={C.border} />
      <Label x={205} y={269} anchor="middle" fill={C.fg} weight={600}>&#8592;</Label>
      <rect x="222" y="252" width="26" height="26" rx="5" fill={C.card} stroke={C.border} />
      <Label x={235} y={269} anchor="middle" fill={C.fg} weight={600}>&#8594;</Label>
      <Label x={256} y={269}>skip 10s</Label>

      <rect x="330" y="252" width="60" height="26" rx="5" fill={C.card} stroke={C.border} />
      <Label x={360} y={269} anchor="middle" fill={C.fg} weight={600}>Ctrl+J</Label>
      <rect x="394" y="252" width="60" height="26" rx="5" fill={C.card} stroke={C.border} />
      <Label x={424} y={269} anchor="middle" fill={C.fg} weight={600}>Ctrl+L</Label>
      <Label x={462} y={269}>step one frame</Label>
    </Figure>
  )
}

/* ------------------------------------------------------------------ */
/* 3. Leaving feedback                                                 */
/* ------------------------------------------------------------------ */

export function FeedbackIllustration() {
  return (
    <Figure
      label="The comment box: a Timecoded or General switch, the editable time pill, the message field, and the attach, voice-note and send buttons."
      viewBox="0 0 640 300"
    >
      {/* composer shell */}
      <rect x="12" y="40" width="616" height="180" rx="10" fill={C.card} stroke={C.border} />

      {/* top strip: placement toggle + time pill */}
      <rect x="12" y="40" width="616" height="34" rx="10" fill={C.muted} opacity="0.6" />
      <rect x="12" y="64" width="616" height="10" fill={C.muted} opacity="0.6" />
      <rect x="26" y="47" width="150" height="20" rx="5" fill={C.muted} stroke={C.border} />
      <rect x="28" y="49" width="74" height="16" rx="4" fill={C.bg} />
      <Label x={65} y={61} anchor="middle" fill={C.amber} weight={700}>Timecoded</Label>
      <Label x={139} y={61} anchor="middle">General</Label>
      <Badge x={101} y={20} n={1} />

      <rect x="192" y="47" width="86" height="20" rx="10" fill="hsl(var(--warning-visible))" stroke={C.amber} />
      <circle cx="205" cy="57" r="4.5" fill="none" stroke={C.amber} strokeWidth="1.2" />
      <Label x={243} y={61} anchor="middle" fill={C.amber} weight={600}>0:12 &#8594; 0:19</Label>
      <Badge x={235} y={20} n={2} />

      {/* message field */}
      <rect x="26" y="86" width="588" height="66" rx="7" fill={C.muted} stroke={C.border} />
      <Bar x={38} y={100} w={330} opacity={0.7} />
      <Bar x={38} y={114} w={244} opacity={0.7} />
      <Bar x={38} y={128} w={160} opacity={0.4} />

      {/* button row */}
      <Label x={26} y={180} size={10}>Enter to send &#183; Shift+Enter for a new line</Label>
      {/* Keyboard-shortcuts button — drawn rather than set as the keyboard glyph,
          which falls back to tofu in most system UI fonts. */}
      <rect x="446" y="164" width="30" height="30" rx="6" fill={C.muted} stroke={C.border} />
      <rect x="453" y="173" width="16" height="12" rx="2" fill="none" stroke={C.fg} strokeWidth="1.2" opacity="0.85" />
      <path
        d="M 456 177 h 1.5 M 460 177 h 1.5 M 464 177 h 1.5 M 456 180.5 h 1.5 M 460 180.5 h 1.5 M 464 180.5 h 1.5"
        stroke={C.fg}
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.85"
      />
      <path d="M 457.5 183.5 h 7" stroke={C.fg} strokeWidth="1.2" strokeLinecap="round" opacity="0.85" />
      <rect x="486" y="164" width="30" height="30" rx="6" fill={C.muted} stroke={C.border} />
      <path d="M 494 186 l 12 -12 a 4 4 0 0 1 6 6 l -12 12" stroke={C.fg} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <rect x="526" y="164" width="30" height="30" rx="6" fill={C.muted} stroke={C.border} />
      <rect x="537" y="171" width="8" height="12" rx="4" fill={C.fg} opacity="0.8" />
      <path d="M 534 184 a 7 7 0 0 0 14 0" stroke={C.fg} strokeWidth="1.4" fill="none" />
      <rect x="566" y="164" width="48" height="30" rx="6" fill={C.primary} />
      <path d="M 580 179 l 20 -8 l -8 20 l -3 -9 z" fill="hsl(var(--primary-foreground))" />
      <path d="M 521 211 v -13" stroke={C.primary} strokeWidth="1.2" strokeDasharray="3 3" />
      <Badge x={521} y={222} n={3} />
      <path d="M 590 211 v -13" stroke={C.primary} strokeWidth="1.2" strokeDasharray="3 3" />
      <Badge x={590} y={222} n={4} />

      {/* posted comment with reply + reactions */}
      <rect x="12" y="240" width="380" height="48" rx="8" fill={C.muted} stroke={C.border} />
      <circle cx="34" cy="264" r="12" fill={C.primary} opacity="0.35" />
      <Bar x={54} y={252} w={120} opacity={0.8} />
      <Bar x={54} y={266} w={200} />
      <Pill x={276} y={248} w={44} h={16} text="Reply" fill={C.card} stroke={C.border} textFill={C.dim} />
      <Pill x={276} y={268} w={34} h={16} text="&#128077; 2" fill={C.card} stroke={C.border} textFill={C.dim} />
      <Pill x={316} y={268} w={30} h={16} text="&#10004;" fill={C.card} stroke={C.border} textFill={C.success} />
      <Badge x={402} y={264} n={5} />
    </Figure>
  )
}

/* ------------------------------------------------------------------ */
/* 4. Versions and sign-off                                            */
/* ------------------------------------------------------------------ */

export function VersionsIllustration() {
  return (
    <Figure
      label="The version dropdown listing v1 to v3, the Request Next Version and Approve Video buttons, and the locked state after approval."
      viewBox="0 0 640 300"
    >
      {/* header slice */}
      <rect x="12" y="12" width="616" height="34" rx="8" fill={C.card} stroke={C.border} />
      <Label x={26} y={34} fill={C.fg}>Hero Cut</Label>
      <Label x={92} y={34} fill={C.border} size={13}>/</Label>
      <SelectBox x={104} y={17} w={70} text="v2" accent />
      <Label x={188} y={34} fill={C.warning} size={10} weight={600}>(Newer version available)</Label>
      <Badge x={139} y={62} n={1} />

      {/* open dropdown */}
      <rect x="104" y="80" width="150" height="94" rx="7" fill="hsl(var(--popover))" stroke={C.border} />
      <rect x="110" y="86" width="138" height="26" rx="5" fill={C.muted} opacity="0.6" />
      <Label x={122} y={103} fill={C.fg}>v3 &#183; latest</Label>
      <rect x="110" y="116" width="138" height="26" rx="5" fill={C.primary} opacity="0.22" stroke={C.primary} />
      <Label x={122} y={133} fill={C.fg}>v2</Label>
      <rect x="110" y="146" width="138" height="22" rx="5" fill={C.muted} opacity="0.35" />
      <Label x={122} y={161} fill={C.fg}>v1</Label>

      {/* action row */}
      <rect x="300" y="80" width="328" height="94" rx="8" fill={C.card} stroke={C.border} />
      <rect x="316" y="100" width="140" height="30" rx="6" fill={C.card} stroke={C.border} strokeWidth="1.5" />
      <Label x={386} y={119} anchor="middle" fill={C.fg} weight={600}>Request Next Version</Label>
      <rect x="470" y="100" width="120" height="30" rx="6" fill="hsl(var(--success-solid))" />
      <Label x={530} y={119} anchor="middle" fill="hsl(var(--success-foreground))" weight={600}>Approve Video</Label>
      <Label x={316} y={152} size={10}>Both tell us you are finished &#8212; one asks for a re-cut, one signs off.</Label>
      <Badge x={386} y={192} n={2} />
      <Badge x={530} y={192} n={3} />

      {/* locked state */}
      <rect x="12" y="222" width="616" height="60" rx="8" fill={C.muted} opacity="0.55" stroke={C.border} />
      <rect x="34" y="240" width="18" height="14" rx="3" fill="none" stroke={C.success} strokeWidth="1.6" />
      <path d="M 38 240 v -5 a 5 5 0 0 1 10 0 v 5" stroke={C.success} strokeWidth="1.6" fill="none" />
      <Label x={68} y={246} fill={C.fg} weight={600}>Approved</Label>
      <Label x={68} y={264} size={10}>Feedback locks in on an approved video, and only that version stays on the page.</Label>
      <Badge x={604} y={252} n={4} />
    </Figure>
  )
}

/* ------------------------------------------------------------------ */
/* 5. Photos and files                                                 */
/* ------------------------------------------------------------------ */

export function FilesIllustration() {
  return (
    <Figure
      label="The files browser: folders on the left, selectable files with a download button, and a drop area for sending files back."
      viewBox="0 0 640 300"
    >
      {/* folder rail */}
      <rect x="12" y="12" width="140" height="270" rx="8" fill={C.card} stroke={C.border} />
      <Label x={26} y={34} size={10} weight={700}>FOLDERS</Label>
      <rect x="22" y="44" width="120" height="26" rx="5" fill={C.primary} opacity="0.2" stroke={C.primary} />
      <Label x={34} y={61} fill={C.fg}>Deliverables</Label>
      <rect x="22" y="76" width="120" height="26" rx="5" fill={C.muted} opacity="0.5" />
      <Label x={34} y={93} fill={C.fg}>Stills</Label>
      <rect x="22" y="108" width="120" height="26" rx="5" fill={C.muted} opacity="0.5" />
      <Label x={34} y={125} fill={C.fg}>Your uploads</Label>
      <Badge x={26} y={158} n={1} />

      {/* file grid */}
      <rect x="164" y="12" width="464" height="204" rx="8" fill={C.card} stroke={C.border} />
      {[0, 1, 2].map((col) => [0, 1].map((row) => {
        const x = 180 + col * 150
        const y = 46 + row * 82
        const selected = col === 0 || (col === 1 && row === 0)
        return (
          <g key={`${col}-${row}`}>
            <rect x={x} y={y} width="132" height="68" rx="6" fill={C.muted} stroke={selected ? C.primary : C.border} strokeWidth={selected ? 1.5 : 1} />
            <rect x={x + 8} y={y + 8} width="60" height="36" rx="4" fill={C.border} opacity="0.7" />
            <Bar x={x + 8} y={y + 52} w={70} />
            <rect x={x + 112} y={y + 8} width="12" height="12" rx="3" fill={selected ? C.primary : 'transparent'} stroke={selected ? C.primary : C.border} />
            {selected ? (
              <path
                d={`M ${x + 115} ${y + 14} l 2.5 3 l 4.5 -5.5`}
                stroke="hsl(var(--primary-foreground))"
                strokeWidth="1.6"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
          </g>
        )
      }))}
      <Label x={180} y={32} fill={C.fg} weight={600}>3 selected</Label>
      <rect x="502" y="18" width="112" height="24" rx="6" fill={C.primary} />
      <Label x={558} y={34} anchor="middle" fill="hsl(var(--primary-foreground))" weight={600}>Download (3)</Label>
      <Badge x={470} y={30} n={2} />

      {/* upload strip */}
      <rect x="164" y="226" width="464" height="56" rx="8" fill={C.muted} opacity="0.5" stroke={C.border} strokeDasharray="5 4" />
      <path d="M 358 262 v -18 M 350 252 l 8 -8 l 8 8" stroke={C.primary} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <Label x={378} y={260} fill={C.dim}>Drop files here to send them back to us</Label>
      <Badge x={604} y={254} n={3} />
    </Figure>
  )
}
