const fs = require('fs')
const { promisify } = require('util')
const fsOpen = promisify(fs.open)
const fsRead = promisify(fs.read)
const fsClose = promisify(fs.close)
const cliProgress = require('cli-progress')
const SortedArray = require('sorted-array')

const loadFiles = async (pathBase, loopStartMessage) => {
    const filesList = []

    // compute the list of files to be loaded
    let i = 0
    while (true) {
        const path = `${pathBase}_${i++}`
        if (!fs.existsSync(path)) break
        filesList.push(path)
    }

    // read the metadata about each file
    const metadata = await Promise.all(filesList.map(async filePath => {
        // open the file
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

        return { filePath, translation, ticksPerSecond, pointsBytesCount: Number(pointsBytesCount) }
    }))

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
    const res = await Promise.all(metadata.map(async e => {
        // open the file
        const file = await fsOpen(e.filePath, 'r')

        // read
        const res = await fsRead(file, result.points, e.offset, e.pointsBytesCount, 16)

        // close the file
        fsClose(file)

        // did we read everything?
        if (res.bytesRead !== e.pointsBytesCount) { return 0 }

        // merge translation and save the ticksPerSecond
        result.translation = { ...result.translation, ...e.translation }
        result.ticksPerSecond = e.ticksPerSecond

        // done
        return 1
    }))
    if (res.reduce((a, c) => a + c, 0) !== res.length) { return null }

    // transform the points int a 64bits integers array
    const points = new BigUint64Array(result.points.buffer, result.points.byteOffset, result.points.length / 8)
    result.points = points // .subarray(0, 60)

    // remove the trace saving frames
    {
        const startSavingTraceAddress = BigInt(getLoopStartAddress(result.translation, 'start saving trace'))
        let delta = BigInt(0)
        result.points.forEach((e, i) => {
            // update current timestamp
            if ((i % 2) === 0) {
                result.points[i] -= delta
                return
            }

            // is this a new save?
            if (e !== startSavingTraceAddress) { return }

            // okay, it is a new save, compute delta
            const thisTs = result.points[i - 1]
            const nextTs = result.points[i + 1]
            if (!nextTs) { return }
            delta += nextTs - thisTs
            result.points[i - 1] -= delta
        })
    }

    // compute the number of loops detected in the data set and allocate space for it
    const loopStartAddress = BigInt(getLoopStartAddress(result.translation, loopStartMessage))
    {
        const count = result.points.reduce((a, c, i) => {
            if (!(i & 0x01) || (c !== loopStartAddress)) { return a }
            return a + 1
        }, 0)
        {
            const storage = Buffer.alloc(count * 4)
            result.loopsStarts = new Uint32Array(storage.buffer, storage.byteOffset, storage.length / 4)
        }
        {
            const storage = Buffer.alloc(count * 8)
            result.loopsDurations = new Float64Array(storage.buffer, storage.byteOffset, storage.length / 8)
        }
    }

    // compute all durations in nanoseconds and loops boundaries
    const clockRate = Number(result.ticksPerSecond) / 1000000000.0
    const durationsStorage = Buffer.alloc((result.points.length / 2 - 1) * 8)
    result.durations = new Float64Array(durationsStorage.buffer, durationsStorage.byteOffset, durationsStorage.length / 8)
    const progress = new cliProgress.SingleBar({ }, cliProgress.Presets.shades_classic)
    console.log(`Compute ${(result.durations.length / 1000000.0).toFixed(3)}M durations`)
    progress.start(result.durations.length, 0)
    let loopIndex = 0
    let loopDuration = 0
    for (let i = 0; i < result.durations.length; i++) {
        if ((i % 1000) === 0) { progress.update(i) }

        // compute duration
        result.durations[i] = Number(result.points[(i + 1) * 2] - result.points[i * 2]) / clockRate

        // compute loop start/stop
        if (result.points[i * 2 + 1] === loopStartAddress) {
            result.loopsStarts[loopIndex] = i
            if (loopIndex !== 0) {
                result.loopsDurations[loopIndex - 1] = loopDuration
            }
            ++loopIndex
            loopDuration = result.durations[i]
        } else {
            loopDuration += result.durations[i]
        }
    }
    result.loopsDurations[result.loopsDurations.length - 1] = loopDuration
    progress.stop()

    // done
    return result
}

const getLoopStartAddress = (translation, loopStartMessage) => {
    for (const key in translation) {
        if (translation[key].endsWith(loopStartMessage)) { return key }
    }
    return ''
}

const work = async () => {
    // load the data
    const data = await loadFiles('/tmp/trace', '- begin loop')

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
            const frames = [...data.points.subarray(frameIndexStart * 2, (frameIndexStart + framesCount) * 2).filter((e, i) => i % 2 === 1)]
                .map((address, frameIndex) => { return { location: data.translation[address], duration: data.durations[frameIndexStart + frameIndex] } })
            const loop = { loopIndex: index, frameIndex: data.loopsStarts[index], duration: loopDuration, frames }

            busyLoopsStorage.insert(loop)
            if (busyLoops.length > loopsCount) { busyLoops.splice(busyLoops.length - 1, 1) }
            smallestLoopDuration = busyLoops[busyLoops.length - 1].loopDuration
        })
        progress.update(data.loopsDurations.length)
        progress.stop()
        console.table(busyLoops)
        console.log(busyLoops[loopsCount - 5])
        console.log(busyLoops[loopsCount - 4])
        console.log(busyLoops[loopsCount - 3])
        console.log(busyLoops[loopsCount - 2])
        console.log(busyLoops[loopsCount - 1])
        console.log(busyLoops[2])
    }
}

work()
