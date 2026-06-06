const SECTION_HEADERS = /^(EXPERIENCE|WORK EXPERIENCE|EDUCATION|SKILLS|TECHNICAL SKILLS|PROJECTS|SUMMARY|OBJECTIVE|CERTIFICATIONS|AWARDS|PUBLICATIONS)/im

const SECTION_MAP: Record<string, string> = {
  'EXPERIENCE': 'experience',
  'WORK EXPERIENCE': 'work_experience',
  'EDUCATION': 'education',
  'SKILLS': 'skills',
  'TECHNICAL SKILLS': 'technical_skills',
  'PROJECTS': 'projects',
  'SUMMARY': 'summary',
  'OBJECTIVE': 'objective',
  'CERTIFICATIONS': 'certifications',
  'AWARDS': 'awards',
  'PUBLICATIONS': 'publications',
}

export interface CvChunk {
  section: string
  text: string
}

export function chunkCv(rawText: string): CvChunk[] {
  const lines = rawText.split('\n')
  const chunks: CvChunk[] = []
  let currentSection = 'summary'
  let buffer: string[] = []

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase()
    const matched = Object.keys(SECTION_MAP).find(key => trimmed.startsWith(key))

    if (matched) {
      if (buffer.length > 0) {
        chunks.push({ section: currentSection, text: buffer.join('\n').trim() })
        buffer = []
      }
      // `matched` is a key of SECTION_MAP, so this is always defined;
      // the `!` is required because tsconfig has noUncheckedIndexedAccess.
      currentSection = SECTION_MAP[matched]!
    } else {
      buffer.push(line)
    }
  }

  if (buffer.length > 0) {
    chunks.push({ section: currentSection, text: buffer.join('\n').trim() })
  }

  return chunks.filter(c => c.text.length > 30)
}
