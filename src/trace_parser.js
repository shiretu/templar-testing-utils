const fs = require('fs')
const { promisify } = require('util')
const fsOpen = promisify(fs.open)
const fsRead = promisify(fs.read)
const fsClose = promisify(fs.close)
const cliProgress = require('cli-progress')
const SortedArray = require('sorted-array')

const getLoopStartAddress = (translation, loopStartMessage) => {
    for (const key in translation) {
        if (translation[key].endsWith(loopStartMessage)) { return key }
    }
    return ''
}

const loadFiles = async (pathBase) => {
    const filesList = []

    // compute the list of files to be loaded
    let i = 0
    while (true) {
        const path = `${pathBase}_${i++}`
        if (!fs.existsSync(path)) break
        filesList.push(path)
    }

    // read the metadata about each file
    const metadata = []
    {
        console.log(`Load metadata for ${filesList.length} files`)
        const progress = new cliProgress.SingleBar({ }, cliProgress.Presets.shades_classic)
        progress.start(filesList.length, 0)
        for (let i = 0; i < filesList.length; ++i) {
            progress.increment()

            // open the file
            const filePath = filesList[i]
            const file = await fsOpen(filePath, 'r')

            // read the header
            const header = Buffer.alloc(16)
            await fsRead(file, header, 0, header.length, 0)
            const ticksPerSecond = header.readBigUInt64LE(0)
            const pointsBytesCount = header.readBigUInt64LE(8)

            // read the translation table
            const entry = Buffer.alloc(12)
            let cursor = Number(pointsBytesCount) + 16
            const translation = {}
            while (true) {
                {
                    const res = await fsRead(file, entry, 0, entry.length, cursor)
                    if (res.bytesRead !== 12) { break }
                }
                const address = entry.readBigUInt64LE()
                const length = entry.readUint32LE(8)
                const str = Buffer.alloc(length)
                {
                    const res = await fsRead(file, str, 0, str.length, cursor + 12)
                    if (res.bytesRead !== length) { break }
                }

                translation[address] = str.toString()

                cursor += (length + 12)
            }

            // close the file
            fsClose(file)

            metadata.push({ filePath, translation, ticksPerSecond, pointsBytesCount: Number(pointsBytesCount) })
        }
        progress.stop()
    }

    // compute the total amount of bytes required and also the storage offsets
    let totalPointsBytesCount = 0
    metadata.forEach(e => {
        e.offset = totalPointsBytesCount
        totalPointsBytesCount += e.pointsBytesCount
    })

    // allocate the buffer which will hold all data
    const result = {
        points: Buffer.alloc(totalPointsBytesCount),
        translation: {}
    }

    // load all data
    console.log(`Load ${filesList.length} data files`)
    const progress = new cliProgress.SingleBar({ }, cliProgress.Presets.shades_classic)
    progress.start(metadata.length, 0)
    // const res = await Promise.all(metadata.map(async e => {
    for (let i = 0; i < metadata.length; ++i) {
        const e = metadata[i]

        // open the file
        const file = await fsOpen(e.filePath, 'r')

        // read
        const res = await fsRead(file, result.points, e.offset, e.pointsBytesCount, 16)

        // close the file
        fsClose(file)

        // did we read everything?
        if (res.bytesRead !== e.pointsBytesCount) { return null }

        // merge translation and save the ticksPerSecond
        result.translation = { ...result.translation, ...e.translation }
        result.ticksPerSecond = e.ticksPerSecond

        progress.increment()
    }
    progress.stop()

    // transform the points int a 64bits integers array
    const points = new BigUint64Array(result.points.buffer, result.points.byteOffset, result.points.length / 8)
    result.points = points

    // done
    return result
}

const adjustTraceSavingFrames = async (data) => {
    // remove the trace saving frames
    console.log(`Filter ${(data.points.length / 2 / 1000000.0).toFixed(3)}M data points`)
    const progress = new cliProgress.SingleBar({ }, cliProgress.Presets.shades_classic)
    progress.start(data.points.length / 2, 0)
    const endSavingTraceAddress = BigInt(getLoopStartAddress(data.translation, 'end saving trace'))
    let delta = BigInt(0)
    for (let i = 0; i < data.points.length / 2; ++i) {
        if ((i % 1000) === 0) { progress.update(i) }
        if (data.points[i * 2 + 1] !== endSavingTraceAddress) {
            data.points[i * 2] -= delta
            continue
        }
        delta = data.points[i * 2] - data.points[(i - 1) * 2]
        data.points[i * 2] -= delta
    }
    progress.stop()
}

const splitLoops = async (data) => {
    // compute the number of loops detected in the data set and allocate space for it
    data.loopStartAddress = BigInt(getLoopStartAddress(data.translation, '- begin loop'))
    data.loopEndAddress = BigInt(getLoopStartAddress(data.translation, '- end loop'))
    {
        const count = data.points.reduce((a, c, i) => {
            if (!(i & 0x01) || (c !== data.loopStartAddress)) { return a }
            return a + 1
        }, 0)
        {
            const storage = Buffer.alloc(count * 4)
            data.loopsStarts = new Uint32Array(storage.buffer, storage.byteOffset, storage.length / 4)
        }
        {
            const storage = Buffer.alloc(count * 8)
            data.loopsDurations = new Float64Array(storage.buffer, storage.byteOffset, storage.length / 8)
        }
    }

    // get the nanoseconds clock rate factor
    const clockRate = Number(data.ticksPerSecond) / 1000000000.0

    // allocate space for the durations
    const durationsStorage = Buffer.alloc((data.points.length / 2 - 1) * 8)
    data.durations = new Float64Array(durationsStorage.buffer, durationsStorage.byteOffset, durationsStorage.length / 8)

    // compute the durations for all frames and create the array of loops
    console.log(`Compute ${(data.durations.length / 1000000.0).toFixed(3)}M durations`)
    const progress = new cliProgress.SingleBar({ }, cliProgress.Presets.shades_classic)
    progress.start(data.durations.length, 0)
    let loopIndex = 0
    let loopDuration = 0
    for (let i = 0; i < data.durations.length; i++) {
        if ((i % 1000) === 0) { progress.update(i) }

        // compute duration
        data.durations[i] = Number(data.points[(i + 1) * 2] - data.points[i * 2]) / clockRate

        // compute loop start/stop
        if (data.points[i * 2 + 1] === data.loopStartAddress) {
            data.loopsStarts[loopIndex] = i
            if (loopIndex !== 0) {
                data.loopsDurations[loopIndex - 1] = loopDuration
            }
            ++loopIndex
            loopDuration = data.durations[i]
        } else {
            if (data.points[i * 2 + 1] !== data.loopEndAddress) {
                loopDuration += data.durations[i]
            }
        }
    }
    data.loopsDurations[data.loopsDurations.length - 1] = loopDuration
    progress.stop()
}

const computeTopLoops = async (data) => {
    // get the top loops
    const loopsCount = 50
    const busyLoopsStorage = new SortedArray([], (a, b) => b.duration - a.duration)
    const busyLoops = busyLoopsStorage.array
    {
        const progress = new cliProgress.SingleBar({ }, cliProgress.Presets.shades_classic)
        console.log(`Scanning ${(data.loopsDurations.length / 1000000.0).toFixed(3)}M loops`)
        progress.start(data.loopsDurations.length, 0)
        let smallestLoopDuration = 0
        data.loopsDurations.forEach((loopDuration, index) => {
            // update progress bar
            if ((index % 1000) === 0) { progress.update(index) }

            // only insert the new stack if it is greater than the smallest one already stored
            if ((busyLoops.length >= loopsCount) && (smallestLoopDuration >= loopDuration)) { return }

            // create the loop info
            const frameIndexStart = data.loopsStarts[index]
            const frameIndexEnd = (index + 1) < data.loopsStarts.length ? data.loopsStarts[index + 1] : data.durations.length
            const framesCount = frameIndexEnd - frameIndexStart
            const frames = [...data.points.subarray(frameIndexStart * 2, (frameIndexStart + framesCount) * 2).filter((e, i) => {
                return ((i % 2) === 1) && (e !== data.loopEndAddress)
            })]
                .map((address, frameIndex) => { return { location: data.translation[address], duration: data.durations[frameIndexStart + frameIndex] } })
            const loop = { loopIndex: index, frameIndex: data.loopsStarts[index], duration: loopDuration, frames }

            busyLoopsStorage.insert(loop)
            if (busyLoops.length > loopsCount) { busyLoops.splice(busyLoops.length - 1, 1) }
            smallestLoopDuration = busyLoops[busyLoops.length - 1].loopDuration
        })
        progress.update(data.loopsDurations.length)
        progress.stop()
        for (let i = 0; i < busyLoops.length; ++i) { console.log(busyLoops[i]) }
        console.table(busyLoops)
    }
}

const computeLoopDurationsHistogram = async (data) => {
    const localLoopDurations = Float64Array.from(data.loopsDurations)
    localLoopDurations.sort()

    const min = localLoopDurations[0]
    const max = localLoopDurations[localLoopDurations.length - 1]
    const step = 100000

    const distribution = []
    for (let i = min; i <= max; i += step) {
        distribution.push({ durationStart: i, durationEnd: i + step, count: 0 })
    }
    distribution.push({ durationStart: max, durationEnd: max + step, count: 0 })

    localLoopDurations.map(e => {
        const index = Math.trunc((e - min) / step)
        distribution[index].count++
        return e
    })

    console.table(distribution)
}

const processFiles = async (pathBase) => {
    const result = await loadFiles(pathBase)
    await adjustTraceSavingFrames(result)
    await splitLoops(result)
    await computeTopLoops(result)
    await computeLoopDurationsHistogram(result)
}

processFiles(process.argv[2])
