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
 *   - practice  → British splits noun "practice" / verb "practise"; handled by
 *                 context in fixPracticeNounVerb instead of the lookup
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

  // The -ed/-ing forms are always the verb, so British is unambiguously -s-
  // ("a practised eye", "practising daily"). The base word is handled by
  // fixPracticeNounVerb below.
  practiced: 'practised',
  practicing: 'practising',
}

// More -ize/-yze verbs; the British form is the same word with -ise/-yse, so
// they're listed bare. Each one also covers -s/-d/-ing, -ization and -izer
// (see buildMap). Only words that are -ise in British spelling — "size",
// "seize", "prize" and "capsize" are -ize everywhere and must stay out.
const IZE_VERBS = [
  'agonize', 'alphabetize', 'antagonize', 'apologize', 'capitalize', 'caramelize', 'centralize',
  'commercialize', 'compartmentalize', 'computerize', 'conceptualize', 'contextualize', 'crystallize',
  'decentralize', 'democratize', 'deodorize', 'desensitize', 'digitize', 'dramatize', 'economize',
  'empathize', 'energize', 'equalize', 'externalize', 'fantasize', 'fertilize', 'formalize',
  'galvanize', 'globalize', 'harmonize', 'homogenize', 'humanize', 'hypnotize', 'hypothesize',
  'idealize', 'idolize', 'immortalize', 'immunize', 'incentivize', 'individualize', 'industrialize',
  'initialize', 'institutionalize', 'internalize', 'italicize', 'itemize', 'jeopardize', 'legalize',
  'legitimize', 'localize', 'magnetize', 'marginalize', 'materialize', 'mechanize', 'mesmerize',
  'metabolize', 'miniaturize', 'mobilize', 'moisturize', 'monetize', 'monopolize', 'motorize',
  'nationalize', 'neutralize', 'oxidize', 'patronize', 'penalize', 'personalize', 'polarize',
  'popularize', 'pressurize', 'privatize', 'publicize', 'randomize', 'rationalize', 'reorganize',
  'revitalize', 'revolutionize', 'romanticize', 'sanitize', 'scrutinize', 'sensitize', 'serialize',
  'stigmatize', 'strategize', 'subsidize', 'synthesize', 'systematize', 'tantalize', 'tenderize',
  'terrorize', 'theorize', 'trivialize', 'urbanize', 'vandalize', 'vaporize', 'verbalize',
  'victimize', 'vocalize', 'weaponize',
  'catalyze', 'paralyze',
]

/**
 * Build the full lookup by expanding regular -s/-ed/-ing inflections from each
 * base stem, without clobbering any explicitly-listed irregular form.
 */
function buildMap(): Record<string, string> {
  const base: Record<string, string> = { ...BASE_MAP }
  for (const us of IZE_VERBS) {
    if (!(us in base)) base[us] = us.replace(/ize$/, 'ise').replace(/yze$/, 'yse')
  }
  const map: Record<string, string> = { ...base }
  const add = (us: string, uk: string) => {
    if (!(us in map)) map[us] = uk
  }
  for (const [us, uk] of Object.entries(base)) {
    // plural / third-person -s
    add(`${us}s`, `${uk}s`)
    // -ize/-ise and -yze/-yse verbs get regular -d and -ing forms. The base
    // ends in "e", so past tense is +d and the gerund drops the "e" for -ing.
    if (us.endsWith('ize') || us.endsWith('yze')) {
      add(`${us}d`, `${uk}d`) // organize → organised, analyze → analysed
      add(`${us.slice(0, -1)}ing`, `${uk.slice(0, -1)}ing`) // organizing → organising
      add(`${us}r`, `${uk}r`) // organizer → organiser
      add(`${us}rs`, `${uk}rs`)
    }
    // -ize verbs' nouns: personalize → personalisation. (-yze has none: the
    // noun of "analyze" is "analysis" in both.)
    if (us.endsWith('ize')) {
      add(`${us.slice(0, -1)}ation`, `${uk.slice(0, -1)}ation`)
      add(`${us.slice(0, -1)}ations`, `${uk.slice(0, -1)}ations`)
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

// practice (noun) / practise (verb). Whisper emits either spelling for either
// sense, so a plain lookup can't fix it — we use the neighbouring word instead.
// Only clear-cut contexts are rewritten; anything else is left as transcribed.
//
// Words that make the next "practice/practise" a noun: determiners,
// possessives, prepositions and common noun modifiers ("best practice",
// "medical practice", "at practice", "after practice").
const PRACTICE_NOUN_BEFORE = [
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our',
  'their', 'some', 'any', 'no', 'more', 'much', 'less', 'every', 'each', 'of', 'in', 'into', 'at',
  'for', 'from', 'after', 'before', 'during', 'with', 'without', 'best', 'good', 'bad', 'better',
  'common', 'standard', 'general', 'private', 'medical', 'legal', 'clinical', 'dental', 'normal',
  'usual', 'regular', 'daily', 'weekly', 'team', 'training', 'football', 'footy', 'netball',
  'cricket', 'soccer', 'rugby', 'music', 'band', 'choir', 'industry', 'business', 'professional',
  "it's", "that's",
]
// Words that make a preceding "practice/practise" a noun ("practice session",
// "practice makes perfect").
const PRACTICE_NOUN_AFTER = [
  'session', 'sessions', 'round', 'rounds', 'match', 'matches', 'game', 'games', 'run', 'runs',
  'test', 'tests', 'exam', 'exams', 'drill', 'drills', 'area', 'areas', 'track', 'range', 'manager',
  'managers', 'nurse', 'nurses', 'owner', 'owners', 'makes', 'material', 'materials',
]
// Words that make the next "practice/practise" a verb. "to" is deliberately
// absent ("going to practice" is usually the noun).
const PRACTICE_VERB_BEFORE = [
  'i', 'we', 'you', 'they', "i'll", "we'll", "you'll", "they'll", 'will', 'would', 'can', 'could',
  'should', 'must', 'might', 'may', "don't", "didn't", "can't", "won't", "couldn't", "shouldn't",
  'never', 'always', 'often', 'regularly', 'also', 'still', 'please', "let's",
]

const wordAlt = (words: string[]) => words.map((w) => w.replace(/'/g, "['’]")).join('|')

const PRACTISE_AS_NOUN_BEFORE = new RegExp(`\\b(${wordAlt(PRACTICE_NOUN_BEFORE)})(\\s+)(practis)(es?)\\b`, 'gi')
const PRACTISE_AS_NOUN_AFTER = new RegExp(`\\b(practis)(es?)(\\s+)(${wordAlt(PRACTICE_NOUN_AFTER)})\\b`, 'gi')
const PRACTICE_AS_VERB = new RegExp(`\\b(${wordAlt(PRACTICE_VERB_BEFORE)})(\\s+)(practic)(e)\\b`, 'gi')

/** "practis"/"practic" stem swap, keeping the source token's casing. */
function swapStem(stem: string, to: 'c' | 's'): string {
  const last = stem[stem.length - 1]
  const upper = last === last.toUpperCase()
  return stem.slice(0, -1) + (upper ? to.toUpperCase() : to)
}

function fixPracticeNounVerb(text: string): string {
  return text
    .replace(PRACTISE_AS_NOUN_BEFORE, (_m, before, sp, stem, end) => `${before}${sp}${swapStem(stem, 'c')}${end}`)
    .replace(PRACTISE_AS_NOUN_AFTER, (_m, stem, end, sp, after) => `${swapStem(stem, 'c')}${end}${sp}${after}`)
    .replace(PRACTICE_AS_VERB, (_m, before, sp, stem, end) => `${before}${sp}${swapStem(stem, 's')}${end}`)
}

/** Convert US spellings in `text` to British, preserving case and punctuation. */
export function convertToBritishEnglish(text: string): string {
  const converted = text.replace(PATTERN, (match) =>
    applyCase(match, AMERICAN_TO_BRITISH[match.toLowerCase()]),
  )
  return fixPracticeNounVerb(converted)
}
