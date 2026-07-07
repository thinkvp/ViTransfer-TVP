/**
 * American → British spelling conversion for transcription output.
 *
 * Whisper (both the local faster-whisper server and OpenAI) transcribes English
 * audio with US spelling regardless of the language hint — the `language`
 * parameter only tells it *which* language is spoken, not which regional
 * spelling to emit. When the configured transcription language is a
 * British-English locale (en-GB, en-AU, en-NZ, en-IE, en-ZA) we post-process
 * the caption/dictation text to convert the well-known US spellings to British.
 *
 * Only *unambiguous* mappings are included. Words whose American form is also a
 * valid — but different — British word are deliberately omitted so we never make
 * an incorrect "correction". Notable exclusions:
 *   - program   → "program" is correct British English for computer programs
 *   - meter     → a "meter" is a measuring device in British English too
 *   - tire      → "tire" also means to grow weary
 *   - check     → "check" is a valid British verb
 *   - practice  → US "practice" collides with the British noun/verb split
 *   - license   → same noun/verb ambiguity
 *   - draft     → "draft" is valid British English (distinct from "draught")
 *   - curb      → "curb" is a valid British verb
 */

// Base American → British stems. Common inflections (-s, -ed, -ing) are derived
// automatically below, so only list the base form unless the inflection is
// irregular.
const BASE_MAP: Record<string, string> = {
  // -our
  color: 'colour',
  colorful: 'colourful',
  favor: 'favour',
  favorite: 'favourite',
  flavor: 'flavour',
  honor: 'honour',
  honorable: 'honourable',
  humor: 'humour',
  labor: 'labour',
  neighbor: 'neighbour',
  neighborhood: 'neighbourhood',
  behavior: 'behaviour',
  harbor: 'harbour',
  rumor: 'rumour',
  odor: 'odour',
  vapor: 'vapour',
  valor: 'valour',
  vigor: 'vigour',
  armor: 'armour',
  endeavor: 'endeavour',
  splendor: 'splendour',
  savory: 'savoury',
  savior: 'saviour',

  // -re
  center: 'centre',
  centered: 'centred',
  centering: 'centring',
  theater: 'theatre',
  fiber: 'fibre',
  caliber: 'calibre',
  liter: 'litre',
  kilometer: 'kilometre',
  centimeter: 'centimetre',
  millimeter: 'millimetre',
  somber: 'sombre',
  specter: 'spectre',

  // -ise / -isation (Australian/UK convention prefers -ise over Oxford -ize)
  organize: 'organise',
  organization: 'organisation',
  realize: 'realise',
  realization: 'realisation',
  recognize: 'recognise',
  apologize: 'apologise',
  analyze: 'analyse',
  criticize: 'criticise',
  emphasize: 'emphasise',
  memorize: 'memorise',
  minimize: 'minimise',
  maximize: 'maximise',
  prioritize: 'prioritise',
  summarize: 'summarise',
  categorize: 'categorise',
  customize: 'customise',
  optimize: 'optimise',
  standardize: 'standardise',
  specialize: 'specialise',
  socialize: 'socialise',
  capitalize: 'capitalise',
  characterize: 'characterise',
  authorize: 'authorise',
  authorization: 'authorisation',
  civilize: 'civilise',
  colonize: 'colonise',
  familiarize: 'familiarise',
  finalize: 'finalise',
  generalize: 'generalise',
  normalize: 'normalise',
  utilize: 'utilise',
  visualize: 'visualise',
  stabilize: 'stabilise',
  sterilize: 'sterilise',
  symbolize: 'symbolise',
  sympathize: 'sympathise',
  synchronize: 'synchronise',
  modernize: 'modernise',
  hospitalize: 'hospitalise',

  // -ce
  defense: 'defence',
  offense: 'offence',
  pretense: 'pretence',

  // -ogue
  catalog: 'catalogue',
  dialog: 'dialogue',
  analog: 'analogue',
  monolog: 'monologue',

  // doubled consonant
  traveling: 'travelling',
  traveled: 'travelled',
  traveler: 'traveller',
  canceled: 'cancelled',
  canceling: 'cancelling',
  modeling: 'modelling',
  modeled: 'modelled',
  labeling: 'labelling',
  labeled: 'labelled',
  fueling: 'fuelling',
  fueled: 'fuelled',
  signaling: 'signalling',
  signaled: 'signalled',
  counselor: 'counsellor',
  jewelry: 'jewellery',
  marvelous: 'marvellous',
  woolen: 'woollen',

  // misc unambiguous
  gray: 'grey',
  mold: 'mould',
  plow: 'plough',
  donut: 'doughnut',
  aluminum: 'aluminium',
  airplane: 'aeroplane',
  pajamas: 'pyjamas',
  mustache: 'moustache',
  cozy: 'cosy',
  maneuver: 'manoeuvre',
  aging: 'ageing',
  artifact: 'artefact',
}

/**
 * Build the full lookup by expanding regular -s/-ed/-ing inflections from each
 * base stem, without clobbering any explicitly-listed irregular form.
 */
function buildMap(): Record<string, string> {
  const map: Record<string, string> = { ...BASE_MAP }
  const add = (us: string, uk: string) => {
    if (!(us in map)) map[us] = uk
  }
  for (const [us, uk] of Object.entries(BASE_MAP)) {
    // plural / third-person -s
    add(`${us}s`, `${uk}s`)
    // -ize/-ise and -yze/-yse verbs get regular -d and -ing forms. The base
    // ends in "e", so past tense is +d and the gerund drops the "e" for -ing.
    if (us.endsWith('ize') || us.endsWith('yze')) {
      add(`${us}d`, `${uk}d`) // organize → organised, analyze → analysed
      add(`${us.slice(0, -1)}ing`, `${uk.slice(0, -1)}ing`) // organizing → organising
    }
    // -our nouns/adjectives: -ed, -ing, -ful, -less variants
    if (uk.endsWith('our')) {
      add(`${us}ed`, `${uk}ed`)
      add(`${us}ing`, `${uk}ing`)
    }
  }
  return map
}

const AMERICAN_TO_BRITISH = buildMap()

const PATTERN = new RegExp(`\\b(${Object.keys(AMERICAN_TO_BRITISH).join('|')})\\b`, 'gi')

/** Match the replacement's casing to the matched source token. */
function applyCase(source: string, replacement: string): string {
  if (source === source.toUpperCase()) return replacement.toUpperCase()
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1)
  }
  return replacement
}

/**
 * British-English locales whose speakers expect British spelling. Plain `en`
 * and `en-US` are intentionally excluded — we only convert when the admin has
 * explicitly chosen a British-English regional locale.
 */
const BRITISH_ENGLISH_LOCALES = new Set(['en-gb', 'en-au', 'en-nz', 'en-ie', 'en-za'])

/** True when the configured language locale expects British spelling. */
export function usesBritishSpelling(language: string | null | undefined): boolean {
  if (!language) return false
  const normalized = language.trim().toLowerCase().replace(/_/g, '-')
  return BRITISH_ENGLISH_LOCALES.has(normalized)
}

/** Convert US spellings in `text` to British, preserving case and punctuation. */
export function convertToBritishEnglish(text: string): string {
  return text.replace(PATTERN, (match) =>
    applyCase(match, AMERICAN_TO_BRITISH[match.toLowerCase()]),
  )
}
