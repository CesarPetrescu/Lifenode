import { Suspense, lazy, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material'

import type { SectionProps } from './types'

type WikiSurface = 'library' | 'indexed'

const WIKI_SURFACE_KEY = 'lifenode_wiki_surface'

const loadKiwixSection = () => import('./MapsSection')
const loadIndexedWikiSection = () => import('./WikiSection')

const KiwixSection = lazy(loadKiwixSection)
const IndexedWikiSection = lazy(loadIndexedWikiSection)

function WikiSurfaceLoading({ label }: { label: string }) {
  return (
    <Box
      sx={{
        minHeight: 280,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Stack direction="row" spacing={1.2} alignItems="center">
        <CircularProgress size={22} />
        <Typography>{`Loading ${label}...`}</Typography>
      </Stack>
    </Box>
  )
}

function preloadWikiSurface(surface: WikiSurface) {
  if (surface === 'library') {
    void loadKiwixSection()
    return
  }
  void loadIndexedWikiSection()
}

export default function WikiWorkspaceSection(props: SectionProps) {
  const [surface, setSurface] = useState<WikiSurface>(() => {
    const saved = localStorage.getItem(WIKI_SURFACE_KEY)
    return saved === 'indexed' ? 'indexed' : 'library'
  })

  useEffect(() => {
    localStorage.setItem(WIKI_SURFACE_KEY, surface)
    preloadWikiSurface(surface)
  }, [surface])

  const surfaceLabel = surface === 'library' ? 'Kiwix Library' : 'Indexed Articles'

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Stack
            direction={{ xs: 'column', lg: 'row' }}
            justifyContent="space-between"
            alignItems={{ xs: 'flex-start', lg: 'center' }}
            spacing={1.5}
          >
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>
                Wiki Workspace
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Kiwix manages full offline libraries. Indexed articles power semantic search and `Ask`
                retrieval against downloaded Wikipedia text.
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              <Chip size="small" label="Kiwix: full ZIM libraries" />
              <Chip size="small" color="secondary" label="Indexed: Ask retrieval corpus" />
            </Stack>
          </Stack>

          <Tabs
            value={surface}
            onChange={(_, value) => setSurface(value as WikiSurface)}
            sx={{ mt: 2 }}
          >
            <Tab
              value="library"
              label="Kiwix Library"
              onMouseEnter={() => preloadWikiSurface('library')}
              onFocus={() => preloadWikiSurface('library')}
            />
            <Tab
              value="indexed"
              label="Indexed Articles"
              onMouseEnter={() => preloadWikiSurface('indexed')}
              onFocus={() => preloadWikiSurface('indexed')}
            />
          </Tabs>

          <Alert severity="info" sx={{ mt: 2 }}>
            {surface === 'library'
              ? 'Use this surface for full offline datasets like Wikipedia, Wiktionary, Wikivoyage, or Stack Exchange ZIM files.'
              : 'Use this surface to download and index specific Wikipedia pages or bulk-ingest text for Semantic Search and Ask > Wiki Retrieval.'}
          </Alert>
        </CardContent>
      </Card>

      <Suspense fallback={<WikiSurfaceLoading label={surfaceLabel} />}>
        {surface === 'library'
          ? <KiwixSection {...props} mode="kiwix" />
          : <IndexedWikiSection {...props} />}
      </Suspense>
    </Stack>
  )
}
