import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { parse } from 'yaml'
import 'bootstrap/dist/css/bootstrap.min.css'
import 'katex/dist/katex.min.css'
import quizSource from './quiz.yaml?raw'

/* ───────────────────────── Dane ───────────────────────── */

type Difficulty = 'podstawowy' | 'średni' | 'trudny'

interface Answer {
  key: string
  text: string
  explanation: string
}

interface Question {
  id: number
  topic: string
  difficulty: Difficulty
  question: string
  correct: string
  answers: Answer[]
}

interface QuizData {
  quiz: { title: string; level: string }
  questions: Question[]
}

const DATA = parse(quizSource) as QuizData
const QUESTIONS = DATA.questions
const BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]))

const DIFF: Record<Difficulty, { label: string; points: number; color: string }> = {
  podstawowy: { label: 'Podstawowy', points: 100, color: 'success' },
  'średni': { label: 'Średni', points: 200, color: 'warning' },
  trudny: { label: 'Na szóstkę', points: 300, color: 'danger' },
}
const DIFF_ORDER: Difficulty[] = ['podstawowy', 'średni', 'trudny']

const DELAY_CORRECT_MS = 5000
const DELAY_WRONG_MS = 10000
const STORAGE_KEY = 'quiz-chemia-budowa-atomu:v1'

const PRAISE = [
  'Dokładnie tak!',
  'Brawo, jądro stabilne.',
  'Mendelejew byłby dumny.',
  'Trafione w sam nukleon.',
  'Zgadza się co do unita.',
]
const ROAST = [
  'Pudło.',
  'Niestety nie.',
  'Tym razem reakcja nie zaszła.',
  'Rozpad nastąpił. Czytaj wyjaśnienie.',
  'Nie tym razem.',
]

const RANKS = [
  { min: 1, icon: '👑', title: 'Mistrz Mendelejewa' },
  { min: 0.85, icon: '🎓', title: 'Profesor nukleonów' },
  { min: 0.7, icon: '⚗️', title: 'Starszy laborant' },
  { min: 0.5, icon: '🧪', title: 'Praktykant w fartuchu' },
  { min: 0, icon: '☢️', title: 'Niestabilny izotop' },
]

/* ───────────────────────── Pamięć (localStorage) ───────────────────────── */

type Mode = 'all' | 'mistakes'

interface Attempt {
  date: string
  mode: Mode
  total: number
  correct: number
  score: number
  bestStreak: number
  wrongIds: number[]
}

interface Stored {
  attempts: Attempt[]
  last: Record<string, boolean> // id pytania → czy ostatnio dobrze
  bestScore: number
}

const EMPTY: Stored = { attempts: [], last: {}, bestScore: 0 }

function loadStored(): Stored {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const p = JSON.parse(raw) as Partial<Stored>
    return {
      attempts: Array.isArray(p.attempts) ? p.attempts : [],
      last: p.last && typeof p.last === 'object' ? p.last : {},
      bestScore: typeof p.bestScore === 'number' ? p.bestScore : 0,
    }
  } catch {
    return EMPTY
  }
}

function saveStored(s: Stored) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* prywatne okno albo zablokowana pamięć – trudno, gramy bez historii */
  }
}

/* ───────────────────────── Pomocnicze ───────────────────────── */

interface Round {
  question: Question
  answers: Answer[]
}

interface Result {
  id: number
  chosen: string
  correct: boolean
  points: number
}

interface Badge {
  icon: string
  title: string
  desc: string
}

interface Summary {
  attempt: Attempt
  previous: Attempt | null
  newRecord: boolean
  badges: Badge[]
}

type Phase = 'start' | 'play' | 'results'

function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = a[i] as T
    a[i] = a[j] as T
    a[j] = tmp
  }
  return a
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T
}

/** Pytania od łatwych do trudnych, w każdej grupie losowa kolejność; odpowiedzi zawsze tasowane. */
function buildRounds(pool: Question[]): Round[] {
  return DIFF_ORDER.flatMap((d) => shuffle(pool.filter((q) => q.difficulty === d))).map((q) => ({
    question: q,
    answers: shuffle(q.answers),
  }))
}

/** Seria podbija mnożnik o 0,25 za każdą kolejną dobrą odpowiedź, maksymalnie ×2. */
function comboMultiplier(streak: number) {
  return 1 + 0.25 * Math.min(Math.max(streak - 1, 0), 4)
}

function maxStreak(results: Result[]) {
  let best = 0
  let cur = 0
  for (const r of results) {
    cur = r.correct ? cur + 1 : 0
    best = Math.max(best, cur)
  }
  return best
}

function plural(n: number, one: string, few: string, many: string) {
  if (n === 1) return one
  const d = n % 10
  const h = n % 100
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many
}

function pct(part: number, total: number) {
  return total ? Math.round((part / total) * 100) : 0
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('pl-PL', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function rankFor(accuracy: number) {
  return RANKS.find((r) => accuracy >= r.min) ?? RANKS[RANKS.length - 1]!
}

function compareMessage(a: Attempt, p: Attempt | null): string {
  if (!p) return 'To pierwsza próba w tym trybie. Następnym razem będzie z czym się porównać.'
  const wNow = a.total - a.correct
  const wPrev = p.total - p.correct
  if (a.total !== p.total) {
    const now = pct(a.correct, a.total)
    const prev = pct(p.correct, p.total)
    if (now > prev) return `Ostatnio ${prev}% poprawnych, teraz ${now}%. Idzie w dobrą stronę.`
    if (now === prev) return `Tak samo jak ostatnio: ${now}% poprawnych.`
    return `Ostatnio ${prev}% poprawnych, teraz ${now}%. Wyjaśnienia poniżej nie gryzą.`
  }
  if (wNow < wPrev) {
    const tail = wNow === 0 ? 'Teraz zero. Tak się to robi.' : `Teraz tylko ${wNow}. Widać postęp.`
    return `Ostatnio: ${wPrev} ${plural(wPrev, 'błędna odpowiedź', 'błędne odpowiedzi', 'błędnych odpowiedzi')}. ${tail}`
  }
  if (wNow === wPrev) {
    return wNow === 0
      ? 'Znowu bez ani jednego błędu. Nudne, ale imponujące.'
      : `Tyle samo błędów co ostatnio: ${wNow}. Stabilność godna gazu szlachetnego.`
  }
  return `Ostatnio ${wPrev} ${plural(wPrev, 'błąd', 'błędy', 'błędów')}, teraz ${wNow}. Coś się rozpadło – przejrzyj wyjaśnienia poniżej.`
}

function computeBadges(
  attempt: Attempt,
  results: Result[],
  previous: Attempt | null,
  newRecord: boolean,
  firstEver: boolean,
): Badge[] {
  const b: Badge[] = []
  if (attempt.total > 0 && attempt.correct === attempt.total)
    b.push({ icon: '🎯', title: 'Bezbłędnie', desc: 'Wszystko dobrze. Podejrzanie dobrze.' })
  if (attempt.bestStreak >= 10)
    b.push({ icon: '☄️', title: 'Reakcja łańcuchowa', desc: '10 poprawnych odpowiedzi z rzędu.' })
  else if (attempt.bestStreak >= 5)
    b.push({ icon: '🔥', title: 'Rozgrzany', desc: '5 poprawnych odpowiedzi z rzędu.' })
  const hard = results.filter((r) => BY_ID.get(r.id)?.difficulty === 'trudny')
  if (hard.length > 0 && hard.every((r) => r.correct))
    b.push({ icon: '🧠', title: 'Na szóstkę', desc: 'Wszystkie trudne pytania poprawnie.' })
  if (previous && previous.total === attempt.total && attempt.correct > previous.correct)
    b.push({ icon: '📈', title: 'Postęp', desc: 'Lepiej niż poprzednim razem.' })
  if (newRecord) b.push({ icon: '🏆', title: 'Nowy rekord', desc: 'Najwięcej punktów w historii.' })
  if (attempt.mode === 'mistakes' && attempt.correct === attempt.total)
    b.push({ icon: '🩹', title: 'Błędy naprawione', desc: 'Wszystkie dawne pomyłki odrobione.' })
  if (firstEver) b.push({ icon: '🧫', title: 'Pierwsza próba', desc: 'Każdy chemik od czegoś zaczynał.' })
  return b
}

/* ───────────────────────── Markdown + LaTeX ───────────────────────── */

const REMARK = [remarkMath]
const REHYPE = [rehypeKatex]
/** W trybie inline akapity stają się <span>, żeby nie wstawiać <p> do <button>. */
const INLINE: Components = { p: ({ children }) => <span>{children}</span> }

function Md({ children, inline = false }: { children: string; inline?: boolean }) {
  const content = (
    <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={inline ? INLINE : undefined}>
      {children}
    </Markdown>
  )
  return inline ? <span className="md">{content}</span> : <div className="md">{content}</div>
}

/* ───────────────────────── Aplikacja ───────────────────────── */

export default function App() {
  const [stored, setStored] = useState<Stored>(loadStored)
  const [phase, setPhase] = useState<Phase>('start')
  const [mode, setMode] = useState<Mode>('all')
  const [rounds, setRounds] = useState<Round[]>([])
  const [index, setIndex] = useState(0)
  const [chosen, setChosen] = useState<string | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const [streak, setStreak] = useState(0)
  const [phrase, setPhrase] = useState('')
  const [unlockAt, setUnlockAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [summary, setSummary] = useState<Summary | null>(null)

  const round = rounds[index]
  const score = results.reduce((s, r) => s + r.points, 0)
  const lastResult = results[results.length - 1]
  const remaining = Math.max(0, unlockAt - now)
  const locked = chosen !== null && remaining > 0
  const mistakeIds = QUESTIONS.filter((q) => stored.last[q.id] === false).map((q) => q.id)

  /* Motyw jasny/ciemny zgodny z systemem */
  useEffect(() => {
    document.title = DATA.quiz.title
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.setAttribute('data-bs-theme', mq.matches ? 'dark' : 'light')
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  /* Odliczanie blokady przycisku „Dalej” */
  useEffect(() => {
    if (phase !== 'play' || chosen === null) return
    const id = window.setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= unlockAt) window.clearInterval(id)
    }, 100)
    return () => window.clearInterval(id)
  }, [phase, chosen, unlockAt])

  const scrollTop = () => window.scrollTo({ top: 0, behavior: 'smooth' })

  const startQuiz = (m: Mode) => {
    const pool = m === 'mistakes' ? QUESTIONS.filter((q) => stored.last[q.id] === false) : QUESTIONS
    if (pool.length === 0) return
    setMode(m)
    setRounds(buildRounds(pool))
    setIndex(0)
    setChosen(null)
    setResults([])
    setStreak(0)
    setSummary(null)
    setPhase('play')
    scrollTop()
  }

  const answer = (key: string) => {
    if (!round || chosen !== null) return
    const ok = key === round.question.correct
    const newStreak = ok ? streak + 1 : 0
    const points = ok ? Math.round(DIFF[round.question.difficulty].points * comboMultiplier(newStreak)) : 0
    const t = Date.now()
    setChosen(key)
    setStreak(newStreak)
    setPhrase(pick(ok ? PRAISE : ROAST))
    setResults((r) => [...r, { id: round.question.id, chosen: key, correct: ok, points }])
    setNow(t)
    setUnlockAt(t + (ok ? DELAY_CORRECT_MS : DELAY_WRONG_MS))
  }

  const finish = () => {
    const correct = results.filter((r) => r.correct).length
    const total = results.length
    const attempt: Attempt = {
      date: new Date().toISOString(),
      mode,
      total,
      correct,
      score,
      bestStreak: maxStreak(results),
      wrongIds: results.filter((r) => !r.correct).map((r) => r.id),
    }
    const previous = [...stored.attempts].reverse().find((a) => a.mode === mode) ?? null
    const newRecord = mode === 'all' && stored.attempts.some((a) => a.mode === 'all') && score > stored.bestScore
    const last = { ...stored.last }
    for (const r of results) last[String(r.id)] = r.correct
    const next: Stored = {
      attempts: [...stored.attempts, attempt].slice(-50),
      last,
      bestScore: mode === 'all' ? Math.max(stored.bestScore, score) : stored.bestScore,
    }
    setStored(next)
    saveStored(next)
    setSummary({
      attempt,
      previous,
      newRecord,
      badges: computeBadges(attempt, results, previous, newRecord, stored.attempts.length === 0),
    })
    setPhase('results')
    scrollTop()
  }

  const next = () => {
    if (chosen === null || locked) return
    if (index + 1 < rounds.length) {
      setIndex((i) => i + 1)
      setChosen(null)
      scrollTop()
    } else {
      finish()
    }
  }

  const abort = () => {
    if (window.confirm('Przerwać quiz? Ta próba nie zostanie zapisana.')) setPhase('start')
  }

  const resetStats = () => {
    if (window.confirm('Na pewno wyzerować całą historię i statystyki?')) {
      setStored(EMPTY)
      saveStored(EMPTY)
    }
  }

  /* Klawiatura: 1–4 / A–D wybiera odpowiedź, Enter przechodzi dalej */
  useEffect(() => {
    if (phase !== 'play') return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (chosen === null) {
        const k = e.key.toLowerCase()
        const i = k.length === 1 ? Math.max('1234'.indexOf(k), 'abcd'.indexOf(k)) : -1
        const a = i >= 0 ? round?.answers[i] : undefined
        if (a) {
          e.preventDefault()
          answer(a.key)
        }
      } else if (e.key === 'Enter') {
        const target = e.target instanceof HTMLElement ? e.target : null
        if (target?.closest('button:not(:disabled)')) return // przycisk sam obsłuży Enter
        e.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <>
      <style>{CSS}</style>
      <main className="container quiz-wrap py-3 py-md-5">
        {phase === 'start' && (
          <StartScreen stored={stored} mistakes={mistakeIds.length} onStart={startQuiz} onReset={resetStats} />
        )}

        {phase === 'play' && round && (
          <section>
            <div className="d-flex align-items-center gap-2 mb-2 small">
              <button type="button" className="btn btn-sm btn-link text-secondary px-0" onClick={abort}>
                ✕ Przerwij
              </button>
              <span className="ms-auto text-secondary">
                Pytanie <strong className="text-body">{index + 1}</strong> / {rounds.length}
              </span>
            </div>
            <div className="progress mb-3" role="progressbar" aria-label="Postęp quizu" style={{ height: 8 }}>
              <div
                className="progress-bar"
                style={{ width: `${((index + (chosen ? 1 : 0)) / rounds.length) * 100}%` }}
              />
            </div>

            <div className="d-flex align-items-center gap-3 mb-3">
              <div className="score-box position-relative">
                <div className="text-secondary small">Punkty</div>
                <div className="fs-4 fw-bold lh-1">{score}</div>
                {chosen !== null && lastResult && lastResult.points > 0 && (
                  <span key={index} className="float-points">
                    +{lastResult.points}
                  </span>
                )}
              </div>
              <div className={`ms-auto text-end ${streak >= 3 ? 'streak-hot' : ''}`}>
                <div className="text-secondary small">Seria</div>
                <div className="fs-4 fw-bold lh-1">
                  {streak > 0 ? '🔥' : '·'} {streak}
                  {streak >= 2 && (
                    <span className="badge text-bg-warning ms-2 align-middle fs-6">
                      ×{comboMultiplier(streak).toFixed(2).replace('.', ',')}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="card shadow-sm border-0 mb-3">
              <div className="card-body p-3 p-md-4">
                <div className="d-flex flex-wrap gap-2 mb-3">
                  <span className={`badge text-bg-${DIFF[round.question.difficulty].color}`}>
                    {DIFF[round.question.difficulty].label} · {DIFF[round.question.difficulty].points} pkt
                  </span>
                  <span className="badge text-bg-secondary">{round.question.topic}</span>
                </div>
                <div className="fs-5 fw-semibold question">
                  <Md>{round.question.question}</Md>
                </div>
              </div>
            </div>

            <div className="d-grid gap-2 mb-3">
              {round.answers.map((a, i) => {
                const isCorrect = a.key === round.question.correct
                const isChosen = a.key === chosen
                let cls = 'answer-btn'
                if (chosen !== null) {
                  if (isCorrect) cls += ' is-correct'
                  else if (isChosen) cls += ' is-wrong'
                  else cls += ' is-dim'
                  if (isChosen) cls += ' picked'
                }
                return (
                  <button
                    key={a.key}
                    type="button"
                    className={cls}
                    disabled={chosen !== null}
                    onClick={() => answer(a.key)}
                  >
                    <span className="answer-letter">
                      {chosen === null ? 'ABCD'[i] : isCorrect ? '✓' : isChosen ? '✗' : 'ABCD'[i]}
                    </span>
                    <span className="answer-body">
                      <Md inline>{a.text}</Md>
                      {chosen !== null && (
                        <span className="answer-expl">
                          <Md inline>{a.explanation}</Md>
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>

            {chosen !== null && lastResult && (
              <div
                className={`alert ${lastResult.correct ? 'alert-success' : 'alert-danger'} d-flex align-items-center gap-2 feedback`}
                role="status"
              >
                <span className="fs-3">{lastResult.correct ? '✅' : '❌'}</span>
                <div>
                  <div className="fw-bold">{phrase}</div>
                  <div className="small">
                    {lastResult.correct
                      ? `+${lastResult.points} pkt${streak >= 2 ? ` (seria ${streak}, mnożnik ×${comboMultiplier(streak).toFixed(2).replace('.', ',')})` : ''}`
                      : 'Seria przepada. Przeczytaj, dlaczego – to po to jest ta blokada.'}
                  </div>
                </div>
              </div>
            )}

            {chosen !== null && (
              <div className="next-bar">
                <button
                  type="button"
                  className="btn btn-primary btn-lg w-100 next-btn"
                  disabled={locked}
                  onClick={next}
                >
                  {locked && (
                    <span
                      className="next-fill"
                      style={{
                        width: `${100 - (remaining / (lastResult?.correct ? DELAY_CORRECT_MS : DELAY_WRONG_MS)) * 100}%`,
                      }}
                    />
                  )}
                  <span className="position-relative">
                    {locked
                      ? `Ładowanie… ${Math.ceil(remaining / 1000)} s`
                      : index + 1 < rounds.length
                        ? 'Dalej →'
                        : 'Zobacz wynik 🏁'}
                  </span>
                </button>
                <div className="text-center text-secondary small mt-1 d-none d-md-block">
                  {locked ? ' ' : 'albo naciśnij Enter'}
                </div>
              </div>
            )}

            {chosen === null && (
              <div className="text-center text-secondary small d-none d-md-block">
                Klawiatura: <kbd>1</kbd>–<kbd>4</kbd> albo <kbd>A</kbd>–<kbd>D</kbd>
              </div>
            )}
          </section>
        )}

        {phase === 'results' && summary && (
          <ResultsScreen
            summary={summary}
            results={results}
            stored={stored}
            mistakes={mistakeIds.length}
            onStart={startQuiz}
            onMenu={() => setPhase('start')}
          />
        )}
      </main>
    </>
  )
}

/* ───────────────────────── Ekran startowy ───────────────────────── */

function StartScreen({
  stored,
  mistakes,
  onStart,
  onReset,
}: {
  stored: Stored
  mistakes: number
  onStart: (m: Mode) => void
  onReset: () => void
}) {
  const mastered = QUESTIONS.filter((q) => stored.last[q.id] === true).length
  const lastAttempt = stored.attempts[stored.attempts.length - 1]
  const counts = DIFF_ORDER.map((d) => ({ d, n: QUESTIONS.filter((q) => q.difficulty === d).length }))

  return (
    <section>
      <div className="text-center mb-4">
        <div className="hero-atom" aria-hidden="true">
          ⚛️
        </div>
        <h1 className="fw-bold mb-1">{DATA.quiz.title}</h1>
        <p className="text-secondary mb-3">{DATA.quiz.level}</p>
        <div className="d-flex flex-wrap justify-content-center gap-2">
          <span className="badge rounded-pill text-bg-primary">{QUESTIONS.length} pytania</span>
          {counts.map(({ d, n }) => (
            <span key={d} className={`badge rounded-pill text-bg-${DIFF[d].color}`}>
              {DIFF[d].label}: {n}
            </span>
          ))}
        </div>
      </div>

      {stored.attempts.length > 0 && (
        <div className="card shadow-sm border-0 mb-3">
          <div className="card-body">
            <div className="row g-2 text-center mb-3">
              <StatTile label="Podejścia" value={stored.attempts.length} />
              <StatTile label="Rekord" value={stored.bestScore} />
              <StatTile label="Opanowane" value={`${mastered}/${QUESTIONS.length}`} />
            </div>
            <div className="progress mb-2" style={{ height: 10 }} role="progressbar" aria-label="Opanowane pytania">
              <div className="progress-bar bg-success" style={{ width: `${pct(mastered, QUESTIONS.length)}%` }} />
            </div>
            {lastAttempt && (
              <div className="small text-secondary">
                Ostatnio ({fmtDate(lastAttempt.date)}): {lastAttempt.correct}/{lastAttempt.total} poprawnie,{' '}
                {lastAttempt.score} pkt.
                {mistakes > 0
                  ? ` Do poprawy: ${mistakes} ${plural(mistakes, 'pytanie', 'pytania', 'pytań')}.`
                  : ' Wszystkie pytania ostatnio dobrze. Nieźle.'}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card shadow-sm border-0 mb-4">
        <div className="card-body">
          <h2 className="h6 fw-bold mb-2">Zasady gry</h2>
          <ul className="small mb-0 ps-3 rules">
            <li>Pytania idą od łatwych do trudnych, a odpowiedzi są za każdym razem tasowane.</li>
            <li>Punkty za dobrą odpowiedź: 100 / 200 / 300 zależnie od trudności.</li>
            <li>Seria dobrych odpowiedzi podbija mnożnik, aż do ×2. Jedna pomyłka i seria przepada.</li>
            <li>
              Po każdej odpowiedzi jest chwila na przeczytanie wyjaśnień: 5 s przy dobrej, 10 s przy złej. Przeklikać
              się nie da.
            </li>
          </ul>
        </div>
      </div>

      <div className="d-grid gap-2">
        <button type="button" className="btn btn-primary btn-lg" onClick={() => onStart('all')}>
          {stored.attempts.length ? 'Zagraj jeszcze raz' : 'Start'} 🚀
        </button>
        {mistakes > 0 && (
          <button type="button" className="btn btn-outline-danger btn-lg" onClick={() => onStart('mistakes')}>
            Powtórz tylko błędne ({mistakes})
          </button>
        )}
        {stored.attempts.length > 0 && (
          <button type="button" className="btn btn-link btn-sm text-secondary mt-2" onClick={onReset}>
            Wyzeruj historię
          </button>
        )}
      </div>
    </section>
  )
}

/* ───────────────────────── Wyniki ───────────────────────── */

function ResultsScreen({
  summary,
  results,
  stored,
  mistakes,
  onStart,
  onMenu,
}: {
  summary: Summary
  results: Result[]
  stored: Stored
  mistakes: number
  onStart: (m: Mode) => void
  onMenu: () => void
}) {
  const { attempt, previous, newRecord, badges } = summary
  const accuracy = attempt.total ? attempt.correct / attempt.total : 0
  const rank = rankFor(accuracy)
  const wrong = results.filter((r) => !r.correct)
  const history = stored.attempts.slice(-12)

  const groupBy = (keyOf: (q: Question) => string) => {
    const map = new Map<string, { ok: number; total: number }>()
    for (const r of results) {
      const q = BY_ID.get(r.id)
      if (!q) continue
      const k = keyOf(q)
      const v = map.get(k) ?? { ok: 0, total: 0 }
      v.total += 1
      if (r.correct) v.ok += 1
      map.set(k, v)
    }
    return [...map.entries()]
  }
  const byDifficulty = groupBy((q) => DIFF[q.difficulty].label)
  const byTopic = groupBy((q) => q.topic)

  return (
    <section>
      <div className="text-center mb-4">
        <div className="rank-icon" aria-hidden="true">
          {rank.icon}
        </div>
        <div className="text-secondary small text-uppercase fw-semibold">Twój tytuł</div>
        <h1 className="fw-bold mb-3">{rank.title}</h1>
        <div className="d-flex justify-content-center">
          <div className="ring" style={{ '--p': Math.round(accuracy * 100) } as CSSProperties}>
            <div className="ring-inner">{Math.round(accuracy * 100)}%</div>
          </div>
        </div>
        {newRecord && <div className="badge text-bg-warning fs-6 mt-3">🏆 Nowy rekord!</div>}
      </div>

      <div className="row g-2 text-center mb-3">
        <StatTile label="Punkty" value={attempt.score} />
        <StatTile label="Dobrze" value={`${attempt.correct}/${attempt.total}`} />
        <StatTile label="Najdłuższa seria" value={`🔥 ${attempt.bestStreak}`} />
      </div>

      <div className={`alert ${previous && attempt.correct < previous.correct && attempt.total === previous.total ? 'alert-warning' : 'alert-info'}`}>
        {compareMessage(attempt, previous)}
      </div>

      {badges.length > 0 && (
        <div className="mb-4">
          <h2 className="h6 fw-bold">Odznaki</h2>
          <div className="row g-2">
            {badges.map((b) => (
              <div key={b.title} className="col-6 col-md-4">
                <div className="badge-tile h-100">
                  <div className="fs-2">{b.icon}</div>
                  <div className="fw-bold small">{b.title}</div>
                  <div className="text-secondary small">{b.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card shadow-sm border-0 mb-4">
        <div className="card-body">
          <h2 className="h6 fw-bold">Według trudności</h2>
          {byDifficulty.map(([k, v]) => (
            <Bar key={k} label={k} ok={v.ok} total={v.total} />
          ))}
          <h2 className="h6 fw-bold mt-3">Według tematu</h2>
          {byTopic.map(([k, v]) => (
            <Bar key={k} label={k} ok={v.ok} total={v.total} />
          ))}
        </div>
      </div>

      {history.length > 1 && (
        <div className="card shadow-sm border-0 mb-4">
          <div className="card-body">
            <h2 className="h6 fw-bold">Historia (ostatnie {history.length})</h2>
            <div className="history" aria-label="Skuteczność w kolejnych podejściach">
              {history.map((a, i) => (
                <div
                  key={a.date + i}
                  className={`history-bar ${a.mode === 'mistakes' ? 'is-mistakes' : ''} ${i === history.length - 1 ? 'is-current' : ''}`}
                  style={{ height: `${Math.max(pct(a.correct, a.total), 4)}%` }}
                  title={`${fmtDate(a.date)}: ${a.correct}/${a.total}${a.mode === 'mistakes' ? ' (powtórka błędów)' : ''}`}
                />
              ))}
            </div>
            <div className="small text-secondary mt-2">
              Wysokość słupka = % poprawnych. Czerwone to powtórki błędów, wyróżniony to obecne podejście.
            </div>
          </div>
        </div>
      )}

      {wrong.length > 0 && (
        <div className="mb-4">
          <h2 className="h6 fw-bold">Do poprawki ({wrong.length})</h2>
          {wrong.map((r) => {
            const q = BY_ID.get(r.id)
            if (!q) return null
            const mine = q.answers.find((a) => a.key === r.chosen)
            const good = q.answers.find((a) => a.key === q.correct)
            return (
              <div key={r.id} className="card border-0 shadow-sm mb-2">
                <div className="card-body">
                  <div className="fw-semibold mb-2">
                    <Md>{q.question}</Md>
                  </div>
                  {mine && (
                    <div className="review review-wrong">
                      <div className="small fw-bold">Twoja odpowiedź:</div>
                      <Md inline>{mine.text}</Md>
                      <div className="small mt-1">
                        <Md>{mine.explanation}</Md>
                      </div>
                    </div>
                  )}
                  {good && (
                    <div className="review review-right">
                      <div className="small fw-bold">Poprawna odpowiedź:</div>
                      <Md inline>{good.text}</Md>
                      <div className="small mt-1">
                        <Md>{good.explanation}</Md>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="d-grid gap-2">
        <button type="button" className="btn btn-primary btn-lg" onClick={() => onStart('all')}>
          Jeszcze raz, wszystkie pytania 🔁
        </button>
        {mistakes > 0 && (
          <button type="button" className="btn btn-outline-danger btn-lg" onClick={() => onStart('mistakes')}>
            Powtórz tylko błędne ({mistakes})
          </button>
        )}
        <button type="button" className="btn btn-outline-secondary" onClick={onMenu}>
          Menu
        </button>
      </div>
    </section>
  )
}

/* ───────────────────────── Drobne komponenty ───────────────────────── */

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="col-4">
      <div className="stat-tile">
        <div className="fs-4 fw-bold lh-1">{value}</div>
        <div className="small text-secondary mt-1">{label}</div>
      </div>
    </div>
  )
}

function Bar({ label, ok, total }: { label: string; ok: number; total: number }) {
  const p = pct(ok, total)
  const color = p >= 85 ? 'bg-success' : p >= 50 ? 'bg-warning' : 'bg-danger'
  return (
    <div className="mb-2">
      <div className="d-flex small">
        <span>{label}</span>
        <span className="ms-auto text-secondary">
          {ok}/{total}
        </span>
      </div>
      <div className="progress" style={{ height: 8 }} role="progressbar" aria-label={label}>
        <div className={`progress-bar ${color}`} style={{ width: `${p}%` }} />
      </div>
    </div>
  )
}

/* ───────────────────────── Style ───────────────────────── */

const CSS = `
body { background: var(--bs-tertiary-bg); }
.quiz-wrap { max-width: 760px; min-height: 100svh; }
.card { background: var(--bs-body-bg); border-radius: 1rem; }
.md p:last-child { margin-bottom: 0; }
.md, .answer-body { overflow-wrap: anywhere; }
.katex { font-size: 1.05em; }
.katex-display { overflow-x: auto; overflow-y: hidden; padding: .25rem 0; }
.hero-atom { font-size: 4rem; line-height: 1; animation: spin 12s linear infinite; display: inline-block; }
.rank-icon { font-size: 4rem; line-height: 1; animation: pop .5s; }
.rules li + li { margin-top: .25rem; }

.answer-btn {
  display: flex; gap: .75rem; align-items: flex-start; text-align: left; width: 100%;
  padding: .85rem 1rem; border-radius: .9rem; border: 2px solid var(--bs-border-color);
  background: var(--bs-body-bg); color: var(--bs-body-color);
  transition: transform .12s, border-color .15s, background-color .15s, opacity .2s;
}
.answer-btn:not(:disabled):hover { border-color: var(--bs-primary); transform: translateY(-1px); }
.answer-btn:not(:disabled):active { transform: scale(.99); }
.answer-btn:disabled { cursor: default; }
.answer-letter {
  flex: 0 0 2rem; height: 2rem; border-radius: 50%; display: grid; place-items: center;
  font-weight: 700; background: var(--bs-secondary-bg);
}
.answer-body { flex: 1; min-width: 0; padding-top: .2rem; }
.answer-expl { display: block; font-size: .9rem; margin-top: .4rem; color: var(--bs-secondary-color); }
.answer-btn.is-correct { border-color: var(--bs-success); background: var(--bs-success-bg-subtle); }
.answer-btn.is-correct .answer-letter { background: var(--bs-success); color: #fff; }
.answer-btn.is-wrong { border-color: var(--bs-danger); background: var(--bs-danger-bg-subtle); animation: shake .4s; }
.answer-btn.is-wrong .answer-letter { background: var(--bs-danger); color: #fff; }
.answer-btn.is-correct .answer-expl, .answer-btn.is-wrong .answer-expl { color: var(--bs-body-color); }
.answer-btn.is-dim { opacity: .6; }
.answer-btn.is-correct.picked { animation: pop .35s; }

.feedback { animation: slideUp .25s ease-out; }
.next-bar {
  position: sticky; bottom: 0; z-index: 5;
  padding: 1rem 0 calc(.75rem + env(safe-area-inset-bottom));
  background: linear-gradient(to bottom, transparent, var(--bs-tertiary-bg) 35%);
}
.next-btn { position: relative; overflow: hidden; }
.next-btn:disabled { opacity: .85; }
.next-fill { position: absolute; inset: 0 auto 0 0; background: rgba(255, 255, 255, .25); transition: width .1s linear; }

.float-points {
  position: absolute; left: 100%; top: .4rem; margin-left: .5rem; white-space: nowrap;
  font-weight: 800; color: var(--bs-success); animation: floatUp 1.3s forwards; pointer-events: none;
}
.streak-hot .fs-4 { animation: pulse 1s ease-in-out infinite; display: inline-block; }

.stat-tile, .badge-tile {
  background: var(--bs-body-bg); border-radius: .9rem; padding: .9rem .5rem; height: 100%;
  box-shadow: var(--bs-box-shadow-sm);
}
.badge-tile { text-align: center; animation: pop .4s both; }
.ring {
  width: 9rem; aspect-ratio: 1; border-radius: 50%; display: grid; place-items: center;
  background: conic-gradient(var(--bs-success) calc(var(--p) * 1%), var(--bs-secondary-bg) 0);
}
.ring-inner {
  width: 76%; aspect-ratio: 1; border-radius: 50%; display: grid; place-items: center;
  background: var(--bs-tertiary-bg); font-size: 1.8rem; font-weight: 800;
}
.history { display: flex; align-items: flex-end; gap: 4px; height: 90px; }
.history-bar { flex: 1; border-radius: 4px 4px 0 0; background: var(--bs-primary); opacity: .55; }
.history-bar.is-mistakes { background: var(--bs-danger); }
.history-bar.is-current { opacity: 1; }
.review { border-left: 4px solid; padding: .4rem .75rem; border-radius: .25rem; margin-top: .5rem; }
.review-wrong { border-color: var(--bs-danger); background: var(--bs-danger-bg-subtle); }
.review-right { border-color: var(--bs-success); background: var(--bs-success-bg-subtle); }

@keyframes shake { 0%,100% { transform: translateX(0) } 20%,60% { transform: translateX(-6px) } 40%,80% { transform: translateX(6px) } }
@keyframes pop { 0% { transform: scale(.85); opacity: .4 } 60% { transform: scale(1.04) } 100% { transform: scale(1); opacity: 1 } }
@keyframes floatUp { 0% { opacity: 0; transform: translateY(6px) } 20% { opacity: 1 } 100% { opacity: 0; transform: translateY(-28px) } }
@keyframes pulse { 0%,100% { transform: scale(1) } 50% { transform: scale(1.08) } }
@keyframes slideUp { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes spin { to { transform: rotate(360deg) } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`
