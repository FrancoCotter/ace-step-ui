import React, { useMemo, useRef, useState, useEffect } from 'react';
import { Song } from '../types';
import { Play, Pause, SkipBack, SkipForward, Repeat, Shuffle, Download, Heart, MoreVertical, Volume2, VolumeX, Maximize2, Repeat1, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useResponsive } from '../context/ResponsiveContext';
import { useI18n } from '../context/I18nContext';
import { SongDropdownMenu } from './SongDropdownMenu';
import { ShareModal } from './ShareModal';
import { AlbumCover } from './AlbumCover';

interface SyncedLyricLine {
    time: number;
    endTime?: number;
    hasExplicitEnd?: boolean;
    text: string;
}

interface PlayerProps {
    currentSong: Song | null;
    isPlaying: boolean;
    onTogglePlay: () => void;
    currentTime: number;
    duration: number;
    onSeek: (time: number) => void;
    onNext: () => void;
    onPrevious: () => void;
    volume: number;
    onVolumeChange: (val: number) => void;
    playbackRate: number;
    onPlaybackRateChange: (rate: number) => void;
    audioRef: React.RefObject<HTMLAudioElement>;
    isShuffle: boolean;
    onToggleShuffle: () => void;
    repeatMode: 'none' | 'all' | 'one';
    onToggleRepeat: () => void;
    isLiked: boolean;
    onToggleLike: () => void;
    onNavigateToSong?: (songId: string) => void;
    onNavigateToProfile?: (username: string) => void;
    onOpenVideo?: () => void;
    onReusePrompt?: () => void;
    onAddToPlaylist?: () => void;
    onDelete?: () => void;
    onPlayFirst?: () => void;
    preloadCoverUrls?: string[];
}

const loadedFullscreenCoverUrls = new Set<string>();
const fullscreenCoverColorCache = new Map<string, string>();
const MAX_FULLSCREEN_COVER_CACHE = 18;

function trimFullscreenCoverCache() {
    while (loadedFullscreenCoverUrls.size > MAX_FULLSCREEN_COVER_CACHE) {
        const oldest = loadedFullscreenCoverUrls.values().next().value;
        if (!oldest) break;
        loadedFullscreenCoverUrls.delete(oldest);
        fullscreenCoverColorCache.delete(oldest);
    }

    while (fullscreenCoverColorCache.size > MAX_FULLSCREEN_COVER_CACHE) {
        const oldest = fullscreenCoverColorCache.keys().next().value;
        if (!oldest) break;
        fullscreenCoverColorCache.delete(oldest);
        loadedFullscreenCoverUrls.delete(oldest);
    }
}

function getAverageCoverColor(image: HTMLImageElement): string | null {
    try {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return null;
        canvas.width = 24;
        canvas.height = 24;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            if (alpha < 128) continue;
            const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
            if (brightness < 18 || brightness > 238) continue;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count += 1;
        }
        if (count === 0) return null;
        return `${Math.round(r / count)} ${Math.round(g / count)} ${Math.round(b / count)}`;
    } catch {
        return null;
    }
}

function preloadFullscreenCover(url: string): Promise<string | null> {
    return new Promise(resolve => {
        if (loadedFullscreenCoverUrls.has(url) && fullscreenCoverColorCache.has(url)) {
            resolve(fullscreenCoverColorCache.get(url)!);
            return;
        }

        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
            loadedFullscreenCoverUrls.add(url);
            const color = getAverageCoverColor(image);
            if (color) fullscreenCoverColorCache.set(url, color);
            trimFullscreenCoverCache();
            resolve(color);
        };
        image.onerror = () => resolve(null);
        image.src = url;
    });
}

function cleanLyricText(text: string): string {
    return text
        .split('\n')
        .map(line => line
            .replace(/\[(?:intro|verse|pre[-\s]?chorus|chorus|bridge|outro|hook|refrain|interlude|guitar|breakdown|drop|build|solo|spoken|fade|final(?:\s+chorus)?|post[-\s]?chorus|prelude|ending|song\s+ends?)[^\]]*\]/gi, '')
            .replace(/\[[^\]]+\]/g, '')
            .trim()
        )
        .filter(Boolean)
        .join('\n');
}

function capitalizeLatinLineStart(text: string): string {
    return text.replace(/^(\s*["'([{¿¡]*)([a-z])/, (_match, prefix: string, letter: string) =>
        `${prefix}${letter.toUpperCase()}`
    );
}

function formatDisplayLyricText(text: string): string {
    return text
        .split('\n')
        .map(line => capitalizeLatinLineStart(line))
        .join('\n');
}

function parseTimestamp(timestamp: string): number {
    const [minutes, seconds] = timestamp.split(':');
    return (parseInt(minutes, 10) || 0) * 60 + (parseFloat(seconds) || 0);
}

function vttTimeToSeconds(time: string): number {
    const parts = time.trim().split(':');
    if (parts.length === 3) {
        return (parseInt(parts[0], 10) || 0) * 3600 + (parseInt(parts[1], 10) || 0) * 60 + (parseFloat(parts[2]) || 0);
    }
    if (parts.length === 2) {
        return (parseInt(parts[0], 10) || 0) * 60 + (parseFloat(parts[1]) || 0);
    }
    return parseFloat(time) || 0;
}

function parseSyncedLyrics(raw: string): SyncedLyricLine[] {
    if (!raw.trim()) return [];
    if (!raw.trim().startsWith('WEBVTT') && !raw.includes('-->')) {
        const lines: SyncedLyricLine[] = [];
        raw.split('\n').forEach(rawLine => {
            const matches = [...rawLine.matchAll(/\[(\d{2}:\d{2}(?:\.\d{1,3})?)\]/g)];
            if (matches.length === 0) return;
            const lyricText = formatDisplayLyricText(cleanLyricText(rawLine.replace(/\[(\d{2}:\d{2}(?:\.\d{1,3})?)\]/g, '')));
            if (!lyricText) return;
            matches.forEach(match => lines.push({ time: parseTimestamp(match[1]), text: lyricText }));
        });
        return lines.sort((a, b) => a.time - b.time);
    }

    const lines: SyncedLyricLine[] = [];
    raw.replace(/\r/g, '').split(/\n\s*\n/).forEach(block => {
        const blockLines = block.split('\n').map(line => line.trim()).filter(Boolean);
        const timingLineIndex = blockLines.findIndex(line => line.includes('-->'));
        if (timingLineIndex === -1) return;
        const [start, end] = blockLines[timingLineIndex].split('-->').map(value => value.trim().split(/\s+/)[0]);
        const text = formatDisplayLyricText(cleanLyricText(blockLines.slice(timingLineIndex + 1).join('\n')));
        if (!text) return;
        lines.push({ time: vttTimeToSeconds(start), endTime: end ? vttTimeToSeconds(end) : undefined, hasExplicitEnd: Boolean(end), text });
    });
    return lines.sort((a, b) => a.time - b.time);
}

function getActiveSyncedLyricIndex(lines: SyncedLyricLine[], time: number): number {
    return lines.findIndex((line, index) => {
        const endTime = line.hasExplicitEnd ? line.endTime : lines[index + 1]?.time;
        return time >= line.time && (!endTime || time < endTime);
    });
}

export const Player: React.FC<PlayerProps> = ({
    currentSong,
    isPlaying,
    onTogglePlay,
    currentTime,
    duration,
    onSeek,
    onNext,
    onPrevious,
    volume,
    onVolumeChange,
    playbackRate,
    onPlaybackRateChange,
    audioRef,
    isShuffle,
    onToggleShuffle,
    repeatMode,
    onToggleRepeat,
    isLiked,
    onToggleLike,
    onNavigateToSong,
    onNavigateToProfile,
    onOpenVideo,
    onReusePrompt,
    onAddToPlaylist,
    onDelete,
    onPlayFirst,
    preloadCoverUrls = []
}) => {
    const { user } = useAuth();
    const { isMobile } = useResponsive();
    const { t } = useI18n();
    const progressBarRef = useRef<HTMLDivElement>(null);
    const fullscreenProgressRef = useRef<HTMLDivElement>(null);
    const fullscreenLyricsRef = useRef<HTMLDivElement>(null);
    const lyricsBrowseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastTouchY = useRef<number | null>(null);
    const [isHoveringVolume, setIsHoveringVolume] = useState(false);
    const volumeHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [showDropdown, setShowDropdown] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [shareModalOpen, setShareModalOpen] = useState(false);
    const [showSpeedMenu, setShowSpeedMenu] = useState(false);
    const speedMenuRef = useRef<HTMLDivElement>(null);
    const [syncedLyrics, setSyncedLyrics] = useState<SyncedLyricLine[]>([]);
    const [syncedLyricsLoading, setSyncedLyricsLoading] = useState(false);
    const [coverColor, setCoverColor] = useState('18 18 20');
    const [fullscreenSlideDirection, setFullscreenSlideDirection] = useState<'next' | 'previous'>('next');
    const [fullscreenCoverFailed, setFullscreenCoverFailed] = useState(false);
    const [isBrowsingFullscreenLyrics, setIsBrowsingFullscreenLyrics] = useState(false);

    const shouldLoadSyncedLyrics = Boolean(currentSong?.audioUrl);
    const activeLyricIndex = useMemo(() => {
        if (!syncedLyrics.length) return -1;
        return getActiveSyncedLyricIndex(syncedLyrics, currentTime);
    }, [currentTime, syncedLyrics]);

    useEffect(() => {
        if (!currentSong?.coverUrl) {
            setCoverColor('18 18 20');
            return;
        }

        let cancelled = false;
        const cachedColor = fullscreenCoverColorCache.get(currentSong.coverUrl);
        if (cachedColor) setCoverColor(cachedColor);

        preloadFullscreenCover(currentSong.coverUrl).then(color => {
            if (cancelled) return;
            if (color) {
                setCoverColor(color);
            } else if (!cachedColor) {
                setCoverColor('18 18 20');
            }
        });

        return () => {
            cancelled = true;
        };
    }, [currentSong?.coverUrl]);

    useEffect(() => {
        setFullscreenCoverFailed(false);
    }, [currentSong?.coverUrl]);

    useEffect(() => {
        preloadCoverUrls.forEach((url) => {
            if (!url) return;
            preloadFullscreenCover(url);
        });
    }, [preloadCoverUrls]);

    useEffect(() => {
        if (!currentSong?.audioUrl) {
            setSyncedLyrics([]);
            setSyncedLyricsLoading(false);
            return;
        }

        let cancelled = false;
        const lrcUrl = currentSong.audioUrl.replace(/\.[^/.]+$/, '.lrc');
        setSyncedLyrics([]);
        setSyncedLyricsLoading(true);

        fetch(lrcUrl)
            .then(response => {
                if (!response.ok) throw new Error(`LRC not found: ${response.status}`);
                return response.text();
            })
            .then(text => {
                if (!cancelled) setSyncedLyrics(parseSyncedLyrics(text));
            })
            .catch(() => {
                if (!cancelled) setSyncedLyrics([]);
            })
            .finally(() => {
                if (!cancelled) setSyncedLyricsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [currentSong?.audioUrl]);

    useEffect(() => {
        if (!isFullscreen || isBrowsingFullscreenLyrics || activeLyricIndex < 0) return;
        const container = fullscreenLyricsRef.current;
        const activeLine = container?.querySelector<HTMLElement>(`[data-lyric-index="${activeLyricIndex}"]`);
        if (!container || !activeLine) return;

        const targetTop = activeLine.offsetTop - container.clientHeight / 2 + activeLine.clientHeight / 2;
        container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }, [activeLyricIndex, isBrowsingFullscreenLyrics, isFullscreen, syncedLyrics.length]);

    useEffect(() => {
        setIsBrowsingFullscreenLyrics(false);
        if (lyricsBrowseTimer.current) {
            clearTimeout(lyricsBrowseTimer.current);
            lyricsBrowseTimer.current = null;
        }
    }, [currentSong?.id]);

    useEffect(() => {
        return () => {
            if (lyricsBrowseTimer.current) clearTimeout(lyricsBrowseTimer.current);
        };
    }, []);

    // Close fullscreen on Escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isFullscreen) {
                setIsFullscreen(false);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isFullscreen]);

    // Close speed menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (speedMenuRef.current && !speedMenuRef.current.contains(event.target as Node)) {
                setShowSpeedMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Show minimal player when no song is playing
    if (!currentSong) {
        return (
            <div className="h-20 lg:h-24 bg-white dark:bg-black/95 backdrop-blur border-t border-zinc-200 dark:border-white/10 flex items-center justify-center z-50 transition-colors duration-300 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] dark:shadow-none">
                <button
                    onClick={() => onPlayFirst?.()}
                    className="flex items-center gap-3 text-zinc-400 dark:text-zinc-600 hover:text-zinc-600 dark:hover:text-zinc-400 cursor-pointer transition-colors"
                >
                    <div className="w-10 h-10 lg:w-12 lg:h-12 rounded bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center">
                        <Play size={20} />
                    </div>
                    <span className="text-sm font-medium">{t('selectSongToPlay')}</span>
                </button>
            </div>
        );
    }

    const formatTime = (time: number) => {
        if (isNaN(time)) return "0:00";
        const minutes = Math.floor(time / 60);
        const seconds = Math.floor(time % 60);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    const handleSeekInteraction = (e: React.MouseEvent<HTMLDivElement>, ref: React.RefObject<HTMLDivElement>) => {
        if (!ref.current || !duration) return;
        const rect = ref.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;
        const percentage = Math.max(0, Math.min(1, x / width));
        onSeek(percentage * duration);
    };

    const beginFullscreenLyricsBrowse = () => {
        setIsBrowsingFullscreenLyrics(true);
        if (lyricsBrowseTimer.current) clearTimeout(lyricsBrowseTimer.current);
        lyricsBrowseTimer.current = setTimeout(() => {
            setIsBrowsingFullscreenLyrics(false);
        }, 1400);
    };

    const scrollFullscreenLyricsBy = (deltaY: number) => {
        const container = fullscreenLyricsRef.current;
        if (!container) return;
        beginFullscreenLyricsBrowse();
        container.scrollTop += deltaY * 0.35;
    };

    const progressPercent = duration ? (currentTime / duration) * 100 : 0;

    const handleDownload = async () => {
        if (!currentSong?.audioUrl) return;
        try {
            const response = await fetch(currentSong.audioUrl);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${currentSong.title || 'song'}.mp3`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Download failed:', error);
        }
    };

    if (isMobile) {
        if (isFullscreen) {
            return (
                <div className="fixed inset-0 z-50 bg-gradient-to-b from-zinc-100 to-zinc-50 dark:from-zinc-900 dark:to-black flex flex-col safe-area-inset-top safe-area-inset-bottom transition-colors duration-300">
                    {/* Header with close button */}
                    <div className="flex items-center justify-between px-4 py-3">
                        <button
                            onClick={() => setIsFullscreen(false)}
                            className="p-2 text-zinc-600 dark:text-white/70 tap-highlight-none"
                        >
                            <ChevronDown size={28} />
                        </button>
                        <span className="text-xs text-zinc-500 dark:text-white/50 uppercase tracking-wider">{t('nowPlaying')}</span>
                        <div className="w-11" />
                    </div>

                    {/* Album Art */}
                    <div className="flex-1 flex items-center justify-center px-8 py-4">
                        <div className="w-full max-w-[280px] aspect-square rounded-lg overflow-hidden shadow-2xl">
                            {currentSong.coverUrl ? (
                                <img
                                    src={currentSong.coverUrl}
                                    className="w-full h-full object-cover"
                                    alt="cover"
                                    onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextElementSibling?.classList.remove('hidden'); }}
                                />
                            ) : null}
                            <AlbumCover seed={currentSong.id || currentSong.title} size="full" className={`w-full h-full ${currentSong.coverUrl ? 'hidden' : ''}`} />
                        </div>
                    </div>

                    {/* Song Info */}
                    <div className="px-6 mb-4">
                        <div className="flex items-center justify-between">
                            <div className="flex-1 min-w-0 mr-4">
                                <h2
                                    onClick={() => {
                                        setIsFullscreen(false);
                                        onNavigateToSong?.(currentSong.id);
                                    }}
                                    className="text-xl font-bold text-zinc-900 dark:text-white truncate"
                                >
                                    {currentSong.title}
                                </h2>
                                <p
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (currentSong.creator) {
                                            setIsFullscreen(false);
                                            onNavigateToProfile?.(currentSong.creator);
                                        }
                                    }}
                                    className={`text-sm text-zinc-500 dark:text-white/60 truncate mt-1 ${currentSong.creator ? 'cursor-pointer hover:underline' : ''}`}
                                >
                                    {currentSong.creator || 'Unknown Artist'}
                                </p>
                            </div>
                            <button
                                onClick={onToggleLike}
                                className={`p-2 tap-highlight-none ${isLiked ? 'text-[#6f8f72] dark:text-[#a8c9a4]' : 'text-zinc-400 dark:text-white/50'}`}
                            >
                                <Heart size={24} fill={isLiked ? "currentColor" : "none"} />
                            </button>
                        </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="px-6 mb-2">
                        <div
                            ref={fullscreenProgressRef}
                            className="w-full h-1.5 bg-zinc-300 dark:bg-white/20 rounded-full cursor-pointer relative"
                            onClick={(e) => handleSeekInteraction(e, fullscreenProgressRef)}
                        >
                            <div
                                className="h-full bg-zinc-900 dark:bg-white rounded-full relative"
                                style={{ width: `${progressPercent}%` }}
                            >
                                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-4 h-4 bg-zinc-900 dark:bg-white rounded-full shadow-lg -mr-2" />
                            </div>
                        </div>
                        <div className="flex justify-between mt-2 text-xs text-zinc-500 dark:text-white/50 font-mono">
                            <span>{formatTime(currentTime)}</span>
                            <span>{formatTime(duration || 0)}</span>
                        </div>
                    </div>

                    {/* Main Controls */}
                    <div className="flex items-center justify-center gap-8 py-4">
                        <button
                            onClick={onToggleShuffle}
                            className={`p-2 tap-highlight-none ${isShuffle ? 'text-[#6f8f72] dark:text-[#a8c9a4]' : 'text-zinc-400 dark:text-white/50'}`}
                        >
                            <Shuffle size={22} />
                        </button>
                        <button
                            onClick={onPrevious}
                            className="p-2 text-zinc-800 dark:text-white tap-highlight-none"
                        >
                            <SkipBack size={32} fill="currentColor" />
                        </button>
                        <button
                            onClick={onTogglePlay}
                            className="w-16 h-16 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-black flex items-center justify-center shadow-lg tap-highlight-none"
                        >
                            {isPlaying ? <Pause size={32} fill="currentColor" /> : <Play size={32} fill="currentColor" className="ml-1" />}
                        </button>
                        <button
                            onClick={onNext}
                            className="p-2 text-zinc-800 dark:text-white tap-highlight-none"
                        >
                            <SkipForward size={32} fill="currentColor" />
                        </button>
                        <button
                            onClick={onToggleRepeat}
                            className={`p-2 tap-highlight-none relative ${repeatMode !== 'none' ? 'text-[#6f8f72] dark:text-[#a8c9a4]' : 'text-zinc-400 dark:text-white/50'}`}
                        >
                            {repeatMode === 'one' ? <Repeat1 size={22} /> : <Repeat size={22} />}
                        </button>
                    </div>

                    {/* Volume Control - Vertical */}
                    <div className="flex flex-col items-center gap-3 px-6 py-4">
                        <div className="relative h-32 w-8 flex items-center justify-center">
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={volume}
                                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                                className="w-32 h-8 -rotate-90 origin-center appearance-none bg-transparent cursor-pointer"
                                style={{
                                    WebkitAppearance: 'none',
                                    background: `linear-gradient(to right, rgb(143 182 143) 0%, rgb(143 182 143) ${volume * 100}%, rgb(228 228 231) ${volume * 100}%, rgb(228 228 231) 100%)`
                                }}
                            />
                        </div>
                        <button
                            onClick={() => onVolumeChange(volume === 0 ? 0.8 : 0)}
                            className="text-zinc-400 dark:text-white/50 tap-highlight-none"
                        >
                            {volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                        </button>
                    </div>

                    {/* Extra Actions */}
                    <div className="flex items-center justify-center gap-6 px-6 pb-6 text-zinc-400 dark:text-white/50">
                        {onOpenVideo && (
                            <button onClick={onOpenVideo} className="p-3 tap-highlight-none">
                                <Maximize2 size={20} />
                            </button>
                        )}
                        <button
                            onClick={handleDownload}
                            className="p-3 tap-highlight-none"
                            title={t('downloadAudio')}
                        >
                            <Download size={20} />
                        </button>
                        <button
                            onClick={() => setShowDropdown(!showDropdown)}
                            className="p-3 tap-highlight-none relative"
                        >
                            <MoreVertical size={20} />
                        </button>
                    </div>

                    {showDropdown && (
                        <div className="absolute bottom-24 left-1/2 -translate-x-1/2">
                            <SongDropdownMenu
                                song={currentSong}
                                isOpen={showDropdown}
                                onClose={() => setShowDropdown(false)}
                                isOwner={user?.id === currentSong.userId}
                                position="center"
                                direction="up"
                                onCreateVideo={onOpenVideo}
                                onReusePrompt={onReusePrompt}
                                onAddToPlaylist={onAddToPlaylist}
                                onDelete={onDelete}
                                onShare={() => setShareModalOpen(true)}
                            />
                        </div>
                    )}

                    <ShareModal
                        isOpen={shareModalOpen}
                        onClose={() => setShareModalOpen(false)}
                        song={currentSong}
                    />
                </div>
            );
        }

        return (
            <div className="bg-white dark:bg-black/95 backdrop-blur border-t border-zinc-200 dark:border-white/10 flex flex-col z-50 transition-colors duration-300 safe-area-inset-bottom">
                {/* Progress Bar - taller for touch */}
                <div
                    ref={progressBarRef}
                    className="w-full h-1 bg-zinc-200 dark:bg-zinc-800 cursor-pointer relative"
                    onClick={(e) => handleSeekInteraction(e, progressBarRef)}
                >
                    <div
                        className="h-full bg-[#8fb68f]"
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>

                {/* Main content: Song info left, controls right */}
                <div className="flex items-center px-3 py-2 gap-3">
                    {/* Song Info - takes available space, tap to expand */}
                    <div
                        className="flex items-center gap-3 flex-1 min-w-0"
                        onClick={() => setIsFullscreen(true)}
                    >
                        <div className="w-11 h-11 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden shadow-sm flex-shrink-0 relative">
                            {currentSong.coverUrl ? (
                                <img src={currentSong.coverUrl} className="w-full h-full object-cover" alt="cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                            ) : null}
                            {!currentSong.coverUrl && <AlbumCover seed={currentSong.id || currentSong.title} size="full" className="w-full h-full" />}
                            <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 active:opacity-100 transition-opacity">
                                <ChevronUp size={20} className="text-white" />
                            </div>
                        </div>
                        <div className="overflow-hidden flex-1 min-w-0">
                            <h4 className="text-sm font-semibold text-zinc-900 dark:text-white truncate">
                                {currentSong.title}
                            </h4>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                                {currentSong.creator || 'Unknown Artist'}
                            </p>
                        </div>
                    </div>

                    {/* Mobile Controls - compact */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                            onClick={onToggleLike}
                            className={`p-2 tap-highlight-none ${isLiked ? 'text-[#6f8f72] dark:text-[#a8c9a4]' : 'text-zinc-400'}`}
                        >
                            <Heart size={20} fill={isLiked ? "currentColor" : "none"} />
                        </button>
                        <button
                            onClick={onPrevious}
                            className="p-2 text-zinc-700 dark:text-zinc-300 tap-highlight-none"
                        >
                            <SkipBack size={22} fill="currentColor" />
                        </button>
                        <button
                            onClick={onTogglePlay}
                            className="w-11 h-11 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-black flex items-center justify-center shadow-lg tap-highlight-none"
                        >
                            {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" className="ml-0.5" />}
                        </button>
                        <button
                            onClick={onNext}
                            className="p-2 text-zinc-700 dark:text-zinc-300 tap-highlight-none"
                        >
                            <SkipForward size={22} fill="currentColor" />
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // Desktop fullscreen mode
    if (isFullscreen) {
        const hasDynamicLyrics = syncedLyrics.length > 0;
        const isResolvingDynamicLyrics = shouldLoadSyncedLyrics && syncedLyricsLoading;
        const fullscreenStyle = {
            '--lyrics-color-background': `color-mix(in srgb, rgb(${coverColor}) 56%, black 44%)`,
            '--lyrics-color-inactive': 'color-mix(in srgb, var(--lyrics-color-background) 30%, white 70%)',
            '--lyrics-color-active': 'rgba(255, 255, 255, 1)',
        } as React.CSSProperties;

        return (
            <div
                className="fixed inset-0 z-50 flex flex-col overflow-hidden text-white transition-colors duration-700"
                style={{
                    ...fullscreenStyle,
                    backgroundColor: 'var(--lyrics-color-background)',
                }}
            >

                {/* Header with close button */}
                <div className="relative z-10 flex items-center justify-between px-6 py-4">
                    <button
                        onClick={() => setIsFullscreen(false)}
                        className="p-2 text-white/70 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                    >
                        <ChevronDown size={28} />
                    </button>
                    <span className="text-sm text-white/50 uppercase tracking-wider font-medium">{t('nowPlaying')}</span>
                    <div className="w-11" />
                </div>

                {/* Main content area */}
                <div className="relative z-10 flex-1 min-h-0 flex items-center justify-center px-8 pb-4 overflow-hidden">
                    <div
                        key={currentSong.id}
                        className={`w-full ${fullscreenSlideDirection === 'previous' ? 'now-playing-slide-previous' : 'now-playing-slide-next'}`}
                    >
                        {isResolvingDynamicLyrics ? (
                            <div className="mx-auto flex h-[58vh] max-w-6xl items-center justify-center overflow-hidden py-10">
                                <div className="flex flex-col items-center gap-4 text-zinc-500 dark:text-white/45">
                                    <div className="flex items-end gap-1.5">
                                        <span className="h-5 w-1.5 rounded-full bg-[#8fb68f] animate-pulse" style={{ animationDelay: '0ms' }} />
                                        <span className="h-8 w-1.5 rounded-full bg-[#8fb68f] animate-pulse" style={{ animationDelay: '120ms' }} />
                                        <span className="h-4 w-1.5 rounded-full bg-[#8fb68f] animate-pulse" style={{ animationDelay: '240ms' }} />
                                        <span className="h-7 w-1.5 rounded-full bg-[#8fb68f] animate-pulse" style={{ animationDelay: '360ms' }} />
                                    </div>
                                    <span className="text-xs uppercase tracking-[0.24em]">Syncing lyrics</span>
                                </div>
                            </div>
                        ) : hasDynamicLyrics ? (
                            <div className="mx-auto flex h-[58vh] max-w-6xl items-center justify-center overflow-hidden py-10">
                                <div
                                    ref={fullscreenLyricsRef}
                                    onWheel={(event) => {
                                        event.preventDefault();
                                        scrollFullscreenLyricsBy(event.deltaY);
                                    }}
                                    onTouchStart={(event) => {
                                        lastTouchY.current = event.touches[0]?.clientY ?? null;
                                        beginFullscreenLyricsBrowse();
                                    }}
                                    onTouchMove={(event) => {
                                        const touchY = event.touches[0]?.clientY;
                                        if (touchY === undefined || lastTouchY.current === null) return;
                                        event.preventDefault();
                                        scrollFullscreenLyricsBy(lastTouchY.current - touchY);
                                        lastTouchY.current = touchY;
                                    }}
                                    onTouchEnd={() => {
                                        lastTouchY.current = null;
                                    }}
                                    onMouseDown={beginFullscreenLyricsBrowse}
                                    className={`w-full max-h-full text-center custom-scrollbar transition-[overflow] ${
                                        isBrowsingFullscreenLyrics ? 'overflow-y-auto' : 'overflow-hidden'
                                    }`}
                                >
                                    <div className="flex flex-col items-center justify-center gap-6 py-[24vh]">
                                        {syncedLyrics.map((line, index) => {
                                            const isActive = index === activeLyricIndex;
                                            return (
                                                <button
                                                    key={`${line.time}-${line.text}`}
                                                    type="button"
                                                    data-lyric-index={index}
                                                    onClick={() => {
                                                        beginFullscreenLyricsBrowse();
                                                        onSeek(line.time);
                                                    }}
                                                    title={`Jump to ${formatTime(line.time)}`}
                                                    style={!isActive ? { color: 'var(--lyrics-color-inactive)' } : { color: 'var(--lyrics-color-active)' }}
                                                    className={`mx-auto block w-full max-w-5xl break-words rounded-xl px-8 py-1 text-center text-3xl xl:text-5xl font-bold leading-[1.16] tracking-normal transition-colors duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 ${
                                                        isActive
                                                            ? 'opacity-100'
                                                            : 'opacity-70 hover:!text-white hover:opacity-100'
                                                    }`}
                                                >
                                                    {line.text}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="mx-auto flex h-[58vh] max-w-6xl items-center justify-center overflow-hidden py-10">
                                <div className="relative">
                                    <div className="relative w-[min(52vh,440px)] aspect-square overflow-hidden rounded-2xl">
                                        {currentSong.coverUrl && !fullscreenCoverFailed ? (
                                            <img
                                                key={`cover-${currentSong.coverUrl}`}
                                                src={currentSong.coverUrl}
                                                className="absolute inset-0 h-full w-full object-cover"
                                                alt="cover"
                                                onLoad={() => {
                                                    loadedFullscreenCoverUrls.add(currentSong.coverUrl!);
                                                }}
                                                onError={() => setFullscreenCoverFailed(true)}
                                            />
                                        ) : (
                                            <AlbumCover seed={currentSong.id || currentSong.title} size="full" className="absolute inset-0 h-full w-full" />
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="relative z-10 h-20 lg:h-24 shrink-0 border-t border-black/10 bg-white/62 backdrop-blur-xl dark:border-white/10 dark:bg-black/45">
                    <div
                        ref={fullscreenProgressRef}
                        className="group relative h-1 lg:h-1.5 w-full cursor-pointer bg-black/10 dark:bg-white/15"
                        onClick={(e) => handleSeekInteraction(e, fullscreenProgressRef)}
                    >
                        <div
                            className="h-full bg-zinc-950 group-hover:bg-[#8fb68f] transition-colors dark:bg-white"
                            style={{ width: `${progressPercent}%` }}
                        >
                            <div className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-zinc-950 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 dark:bg-white" style={{ left: `clamp(0px, calc(${progressPercent}% - 6px), calc(100% - 12px))` }} />
                        </div>
                    </div>

                    <div className="flex h-[calc(100%-0.25rem)] w-full items-center justify-between gap-2 px-2 sm:px-4 lg:px-6 lg:h-[calc(100%-0.375rem)]">
                        <div className="flex min-w-0 flex-1 max-w-[30%] lg:max-w-[33%] items-center gap-2 sm:gap-3">
                            <div className="h-10 w-10 lg:h-12 lg:w-12 overflow-hidden rounded bg-black/10 flex-shrink-0 shadow-sm dark:bg-white/10">
                                {currentSong.coverUrl ? (
                                    <img src={currentSong.coverUrl} className="h-full w-full object-cover" alt="cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                                ) : null}
                                {!currentSong.coverUrl && <AlbumCover seed={currentSong.id || currentSong.title} size="full" className="h-full w-full" />}
                            </div>
                            <div className="min-w-0">
                                <h2
                                    onClick={() => {
                                        setIsFullscreen(false);
                                        onNavigateToSong?.(currentSong.id);
                                    }}
                                    className="truncate text-xs sm:text-sm font-bold text-zinc-950 hover:underline cursor-pointer dark:text-white"
                                >
                                    {currentSong.title}
                                </h2>
                                <p
                                    onClick={() => {
                                        if (currentSong.creator) {
                                            setIsFullscreen(false);
                                            onNavigateToProfile?.(currentSong.creator);
                                        }
                                    }}
                                    className={`truncate text-[10px] sm:text-xs text-zinc-600 dark:text-zinc-400 ${currentSong.creator ? 'cursor-pointer hover:underline' : ''}`}
                                >
                                    {currentSong.creator || 'Unknown Artist'}
                                </p>
                            </div>
                            <button
                                onClick={onToggleLike}
                                className={`ml-1 sm:ml-2 hidden flex-shrink-0 transition-colors sm:block ${isLiked ? 'text-[#6f8f72] dark:text-[#a8c9a4]' : 'text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white'}`}
                            >
                                <Heart size={18} fill={isLiked ? "currentColor" : "none"} />
                            </button>
                        </div>

                        <div className="flex flex-shrink-0 flex-col items-center justify-center">
                            <div className="flex items-center gap-2 sm:gap-4 lg:gap-6">
                                <button
                                    onClick={onToggleShuffle}
                                    className={`hidden transition-colors sm:block ${isShuffle ? 'text-[#6f8f72] dark:text-[#a8c9a4]' : 'text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white'}`}
                                >
                                    <Shuffle size={16} />
                                </button>
                                <button
                                    onClick={() => {
                                        setFullscreenSlideDirection('previous');
                                        onPrevious();
                                    }}
                                    className="text-zinc-700 hover:text-zinc-950 transition-colors dark:text-white/85 dark:hover:text-white"
                                >
                                    <SkipBack size={18} className="sm:h-[22px] sm:w-[22px]" fill="currentColor" />
                                </button>
                                <button
                                    onClick={onTogglePlay}
                                    className="h-9 w-9 sm:h-10 sm:w-10 rounded-full bg-zinc-950 text-white flex items-center justify-center shadow-lg shadow-black/20 hover:scale-105 transition-transform dark:bg-white dark:text-black dark:shadow-black/30"
                                >
                                    {isPlaying ? <Pause size={18} className="sm:h-5 sm:w-5" fill="currentColor" /> : <Play size={18} className="ml-0.5 sm:h-5 sm:w-5" fill="currentColor" />}
                                </button>
                                <button
                                    onClick={() => {
                                        setFullscreenSlideDirection('next');
                                        onNext();
                                    }}
                                    className="text-zinc-700 hover:text-zinc-950 transition-colors dark:text-white/85 dark:hover:text-white"
                                >
                                    <SkipForward size={18} className="sm:h-[22px] sm:w-[22px]" fill="currentColor" />
                                </button>
                                <button
                                    onClick={onToggleRepeat}
                                    className={`hidden transition-colors relative sm:block ${repeatMode !== 'none' ? 'text-[#6f8f72] dark:text-[#a8c9a4]' : 'text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white'}`}
                                >
                                    {repeatMode === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
                                    {repeatMode !== 'none' && <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 bg-current rounded-full" />}
                                </button>
                            </div>
                        </div>

                        <div className="flex min-w-0 flex-1 max-w-[30%] lg:max-w-[33%] items-center justify-end gap-1 sm:gap-2 lg:gap-3 text-zinc-500 dark:text-zinc-400">
                            <span className="hidden text-right font-mono text-[10px] text-zinc-600 dark:text-zinc-400 md:block sm:text-xs">
                                {formatTime(currentTime)} / {formatTime(duration || 0)}
                            </span>
                            <div className="relative hidden lg:block" ref={speedMenuRef}>
                                <button
                                    className="px-2 py-1 text-[11px] font-mono font-bold hover:bg-black/5 rounded transition-colors min-w-[42px] text-center dark:hover:bg-white/10"
                                    onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                                >
                                    {playbackRate}x
                                </button>
                                {showSpeedMenu && (
                                    <div className="absolute bottom-full right-0 mb-2 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 min-w-[80px] z-50 dark:bg-zinc-900 dark:border-white/10">
                                        {[0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0].map((rate) => (
                                            <button
                                                key={rate}
                                                onClick={() => {
                                                    onPlaybackRateChange(rate);
                                                    setShowSpeedMenu(false);
                                                }}
                                                className={`w-full px-3 py-1.5 text-left text-xs font-mono hover:bg-zinc-100 transition-colors dark:hover:bg-white/10 ${
                                                    playbackRate === rate ? 'text-[#6f8f72] dark:text-[#a8c9a4] font-bold' : 'text-zinc-600 dark:text-zinc-300'
                                                }`}
                                            >
                                                {rate === 1.0 ? t('normalSpeed') : `${rate}x`}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div
                                className="relative hidden md:block"
                                onMouseEnter={() => {
                                    if (volumeHideTimer.current) clearTimeout(volumeHideTimer.current);
                                    setIsHoveringVolume(true);
                                }}
                                onMouseLeave={() => {
                                    volumeHideTimer.current = setTimeout(() => setIsHoveringVolume(false), 400);
                                }}
                            >
                                <button
                                    onClick={() => onVolumeChange(volume === 0 ? 0.8 : 0)}
                                    className="p-1.5 lg:p-2 hover:bg-black/5 rounded-full transition-colors dark:hover:bg-white/10"
                                >
                                    {volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
                                </button>

                                {isHoveringVolume && (
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 pb-2">
                                        <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-zinc-200 dark:border-white/10 p-2">
                                            <div className="relative h-24 w-8 flex items-center justify-center">
                                                <input
                                                    type="range"
                                                    min="0"
                                                    max="1"
                                                    step="0.01"
                                                    value={volume}
                                                    onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                                                    className="w-24 h-8 -rotate-90 origin-center appearance-none bg-transparent cursor-pointer"
                                                    style={{
                                                        WebkitAppearance: 'none',
                                                        background: `linear-gradient(to right, rgb(143 182 143) 0%, rgb(143 182 143) ${volume * 100}%, rgb(228 228 231) ${volume * 100}%, rgb(228 228 231) 100%)`
                                                    }}
                                                />
                                            </div>
                                            <div className="text-[10px] text-center font-mono text-zinc-600 dark:text-zinc-400 mt-1">
                                                {Math.round(volume * 100)}%
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                            <button
                                onClick={handleDownload}
                                className="hidden p-1.5 lg:block lg:p-2 hover:bg-black/5 rounded-full transition-colors dark:hover:bg-white/10"
                                title={t('downloadAudio')}
                            >
                                <Download size={18} />
                            </button>
                            <div className="relative hidden sm:block">
                                <button
                                    onClick={() => setShowDropdown(!showDropdown)}
                                    className="p-1.5 lg:p-2 hover:bg-black/5 rounded-full transition-colors dark:hover:bg-white/10"
                                >
                                    <MoreVertical size={18} />
                                </button>
                                {showDropdown && (
                                    <SongDropdownMenu
                                        song={currentSong}
                                        isOpen={showDropdown}
                                        onClose={() => setShowDropdown(false)}
                                        isOwner={user?.id === currentSong.userId}
                                        position="right"
                                        direction="up"
                                        onCreateVideo={onOpenVideo}
                                        onReusePrompt={onReusePrompt}
                                        onAddToPlaylist={onAddToPlaylist}
                                        onDelete={onDelete}
                                        onShare={() => setShareModalOpen(true)}
                                    />
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                <ShareModal
                    isOpen={shareModalOpen}
                    onClose={() => setShareModalOpen(false)}
                    song={currentSong}
                />
            </div>
        );
    }

    return (
        <div className="h-20 lg:h-24 bg-white dark:bg-black/95 backdrop-blur border-t border-zinc-200 dark:border-white/10 flex flex-col z-50 transition-colors duration-300 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] dark:shadow-none">

            {/* Progress Bar */}
            <div
                ref={progressBarRef}
                className="w-full h-1 lg:h-1.5 bg-zinc-200 dark:bg-zinc-800 cursor-pointer group relative"
                onClick={(e) => handleSeekInteraction(e, progressBarRef)}
            >
                <div
                    className="h-full bg-zinc-900 dark:bg-white relative group-hover:bg-[#8fb68f] transition-colors"
                    style={{ width: `${progressPercent}%` }}
                >
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-zinc-900 dark:bg-white group-hover:bg-[#8fb68f] rounded-full shadow-lg -mr-2 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                {/* Hit area for easier clicking */}
                <div className="absolute top-1/2 -translate-y-1/2 w-full h-4 -z-10"></div>
            </div>

            <div className="flex-1 flex items-center justify-between px-2 sm:px-4 lg:px-6 gap-2 sm:gap-4">

                {/* Song Info */}
                <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1 max-w-[30%] lg:max-w-[33%]">
                    <div className="w-10 h-10 lg:w-12 lg:h-12 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden shadow-sm flex-shrink-0">
                        {currentSong.coverUrl ? (
                            <img src={currentSong.coverUrl} className="w-full h-full object-cover" alt="cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                        ) : null}
                        {!currentSong.coverUrl && <AlbumCover seed={currentSong.id || currentSong.title} size="full" className="w-full h-full" />}
                    </div>
                    <div className="overflow-hidden min-w-0">
                        <h4
                            onClick={() => onNavigateToSong?.(currentSong.id)}
                            className="text-xs sm:text-sm font-bold text-zinc-900 dark:text-white truncate cursor-pointer hover:underline"
                        >
                            {currentSong.title}
                        </h4>
                        <p
                            onClick={() => currentSong.creator && onNavigateToProfile?.(currentSong.creator)}
                            className={`text-[10px] sm:text-xs text-zinc-500 dark:text-zinc-400 truncate ${currentSong.creator ? 'hover:underline cursor-pointer' : ''}`}
                        >
                            {currentSong.creator || 'Unknown Artist'}
                        </p>
                    </div>
                    <button
                        onClick={onToggleLike}
                        className={`ml-1 sm:ml-2 transition-colors flex-shrink-0 hidden sm:block ${isLiked ? 'text-[#6f8f72] dark:text-[#a8c9a4]' : 'text-zinc-400 hover:text-zinc-900 dark:hover:text-white'}`}
                    >
                        <Heart size={18} fill={isLiked ? "currentColor" : "none"} />
                    </button>
                </div>

                {/* Controls */}
                <div className="flex flex-col items-center justify-center flex-shrink-0">
                    <div className="flex items-center gap-2 sm:gap-4 lg:gap-6">
                        <button
                            onClick={onToggleShuffle}
                            className={`transition-colors hidden sm:block ${isShuffle ? 'text-[#6f8f72] dark:text-[#a8c9a4]' : 'text-zinc-400 hover:text-zinc-900 dark:hover:text-white'}`}
                        >
                            <Shuffle size={16} />
                        </button>
                        <button
                            onClick={onPrevious}
                            className="text-zinc-700 dark:text-zinc-300 hover:text-black dark:hover:text-white transition-colors"
                        >
                            <SkipBack size={18} className="sm:w-[22px] sm:h-[22px]" fill="currentColor" />
                        </button>
                        <button
                            onClick={onTogglePlay}
                            className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-black flex items-center justify-center hover:scale-105 transition-transform shadow-lg"
                        >
                            {isPlaying ? <Pause size={18} className="sm:w-5 sm:h-5" fill="currentColor" /> : <Play size={18} className="sm:w-5 sm:h-5 ml-0.5" fill="currentColor" />}
                        </button>
                        <button
                            onClick={onNext}
                            className="text-zinc-700 dark:text-zinc-300 hover:text-black dark:hover:text-white transition-colors"
                        >
                            <SkipForward size={18} className="sm:w-[22px] sm:h-[22px]" fill="currentColor" />
                        </button>
                        <button
                            onClick={onToggleRepeat}
                            className={`transition-colors hidden sm:block ${repeatMode !== 'none' ? 'text-[#6f8f72] dark:text-[#a8c9a4]' : 'text-zinc-400 hover:text-zinc-900 dark:hover:text-white'} relative`}
                        >
                            {repeatMode === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
                            {repeatMode !== 'none' && <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 bg-current rounded-full"></div>}
                        </button>
                    </div>
                </div>

                {/* Volume & Extras */}
                <div className="flex items-center justify-end gap-1 sm:gap-2 lg:gap-3 min-w-0 flex-1 max-w-[30%] lg:max-w-[33%] text-zinc-500 dark:text-zinc-400">
                    <span className="text-[10px] sm:text-xs font-mono text-right text-zinc-600 dark:text-zinc-400 hidden md:block">
                        {formatTime(currentTime)} / {formatTime(duration || 0)}
                    </span>

                    {/* Playback Speed */}
                    <div className="relative group hidden lg:block" ref={speedMenuRef}>
                        <button
                            className="px-2 py-1 text-[11px] font-mono font-bold hover:bg-zinc-200 dark:hover:bg-white/10 rounded transition-colors min-w-[42px] text-center"
                            onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                        >
                            {playbackRate}x
                        </button>
                        {showSpeedMenu && (
                            <div className="absolute bottom-full right-0 mb-2 bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-zinc-200 dark:border-white/10 py-1 min-w-[80px] z-50">
                                {[0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0].map((rate) => (
                                    <button
                                        key={rate}
                                        onClick={() => {
                                            onPlaybackRateChange(rate);
                                            setShowSpeedMenu(false);
                                        }}
                                        className={`w-full px-3 py-1.5 text-left text-xs font-mono hover:bg-zinc-100 dark:hover:bg-white/10 transition-colors ${
                                            playbackRate === rate ? 'text-[#6f8f72] dark:text-[#a8c9a4] font-bold' : 'text-zinc-700 dark:text-zinc-300'
                                        }`}
                                    >
                                        {rate === 1.0 ? t('normalSpeed') : `${rate}x`}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Volume Control with Vertical Slider */}
                    <div
                        className="relative group hidden md:block"
                        onMouseEnter={() => {
                            if (volumeHideTimer.current) clearTimeout(volumeHideTimer.current);
                            setIsHoveringVolume(true);
                        }}
                        onMouseLeave={() => {
                            volumeHideTimer.current = setTimeout(() => setIsHoveringVolume(false), 400);
                        }}
                    >
                        <button
                            onClick={() => onVolumeChange(volume === 0 ? 0.8 : 0)}
                            className="p-1.5 lg:p-2 hover:bg-zinc-100 dark:hover:bg-white/10 rounded-full transition-colors"
                        >
                            {volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
                        </button>

                        {/* Vertical Volume Slider */}
                        {isHoveringVolume && (
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 pb-2">
                                <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-zinc-200 dark:border-white/10 p-2">
                                    <div className="relative h-24 w-8 flex items-center justify-center">
                                        <input
                                            type="range"
                                            min="0"
                                            max="1"
                                            step="0.01"
                                            value={volume}
                                            onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                                            className="w-24 h-8 -rotate-90 origin-center appearance-none bg-transparent cursor-pointer"
                                            style={{
                                                WebkitAppearance: 'none',
                                                background: `linear-gradient(to right, rgb(143 182 143) 0%, rgb(143 182 143) ${volume * 100}%, rgb(228 228 231) ${volume * 100}%, rgb(228 228 231) 100%)`
                                            }}
                                        />
                                    </div>
                                    <div className="text-[10px] text-center font-mono text-zinc-600 dark:text-zinc-400 mt-1">
                                        {Math.round(volume * 100)}%
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    <button
                        onClick={handleDownload}
                        className="p-1.5 lg:p-2 hover:bg-zinc-100 dark:hover:bg-white/10 rounded-full transition-colors hidden lg:block"
                        title={t('downloadAudio')}
                    >
                        <Download size={18} />
                    </button>
                    <button
                        onClick={() => setIsFullscreen(true)}
                        className="p-1.5 lg:p-2 hover:bg-zinc-100 dark:hover:bg-white/10 rounded-full transition-colors"
                    >
                        <Maximize2 size={16} />
                    </button>
                    <div className="relative hidden sm:block">
                        <button
                            onClick={() => setShowDropdown(!showDropdown)}
                            className="p-1.5 lg:p-2 hover:bg-zinc-100 dark:hover:bg-white/10 rounded-full transition-colors"
                        >
                            <MoreVertical size={18} />
                        </button>
                        <SongDropdownMenu
                            song={currentSong}
                            isOpen={showDropdown}
                            onClose={() => setShowDropdown(false)}
                            isOwner={user?.id === currentSong.userId}
                            position="right"
                            direction="up"
                            onCreateVideo={onOpenVideo}
                            onReusePrompt={onReusePrompt}
                            onAddToPlaylist={onAddToPlaylist}
                            onDelete={onDelete}
                            onShare={() => setShareModalOpen(true)}
                        />
                    </div>
                </div>
            </div>

            <ShareModal
                isOpen={shareModalOpen}
                onClose={() => setShareModalOpen(false)}
                song={currentSong}
            />
        </div>
    );
};
