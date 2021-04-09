"use strict";

const { join } = require("path");
const { createWriteStream } = require("fs");
const { get } = require("https");
const puppeteer = require("puppeteer");
const url = process.argv[2];
const totallyFailed = [];
let failedUrls = [];

async function downloadFile({ absPath, url }) {
  const file = createWriteStream(absPath);
  get(url, function (response) {
    if (response.statusCode === 200) {
      response
        .on("data", function (chunk) {
          file.write(chunk);
        })
        .on("end", function () {
          file.end();
        });
    }
  }).on("error", function (err) {
    console.error(err + " ---> " + url);
  });
}

async function downloader({ songLink, songName, delay }) {
  songLink = songLink.replace(/range=[0-9]+-[0-9]+/, "range=0-999999999");
  songName = songName.replace(/\//, "|");
  const downloadPath = join(process.cwd(), songName);
  await downloadFile({
    url: songLink,
    absPath: downloadPath,
  });
  if (delay !== undefined && delay) {
    await new Promise((res) => setTimeout(res, 1000));
  }
}

async function watchNetwork(page) {
  page.setRequestInterception(true);
  const ads = new Set();
  return new Promise((resolve, reject) => {
    page.on("request", (request) => {
      if (request.resourceType() === "xhr") {
        const url = request.url();
        if (url.match(/range=0/)) {
          ads.add(url.split("com/")[1]);
        } else if (
          url.includes("mime=audio") &&
          !ads.has(url.split("com/")[1])
        ) {
          resolve(url);
          return;
        }
      }
      request.continue();
    });
  });
}

async function getSongName(page) {
  await page.waitForSelector("h1 .ytd-video-primary-info-renderer");
  const videoTitle = await page.evaluate(() => {
    return document.querySelector("h1 .ytd-video-primary-info-renderer")
      .textContent;
  });
  return videoTitle + ".mp3";
}

async function songDownloder({ url, reqCount, browser, delay }) {
  const currPage = await browser.newPage();
  await currPage.goto(url);
  reqCount++;
  const [songLink, songName] = await Promise.all([
    Promise.race([
      watchNetwork(currPage),
      new Promise((res) => {
        setTimeout(res, 10000, "link request overdue!");
      }),
    ]),
    getSongName(currPage),
  ]);
  console.log(url);
  if (songLink === "link request overdue!") {
    console.error(`for url ${url} : get request overdue, droppping download!!`);
    if (reqCount === 4) {
      console.error(
        `for url ${url} : request count exceeded limit, cannot fetch song!!`
      );
      totallyFailed.push(url);
    } else {
      console.error(`url ${url} queued for retry!!`);
      failedUrls.push({ url, reqCount });
    }
  } else {
    await downloader({
      songLink,
      songName,
      delay,
    });
  }
  await currPage.close();
}

async function scrollPageToBottom(page) {
  await page.evaluate(async () => {
    await new Promise((res) => {
      let totalHeight = 0;
      let distance = 100;
      let timer = setInterval(() => {
        let scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          res();
        }
      }, 100);
    });
  });
}

async function callUrlDownloader({ allUrls, browser }) {
  for (let i = 0, sz = allUrls.length; i < sz; i++) {
    let j = i,
      smSz = Math.min(i + 10, sz);
    const someSongs_p = [];
    while (j < smSz) {
      const currSong_p = songDownloder({
        ...allUrls[j++],
        browser,
      });
      someSongs_p.push(currSong_p);
    }
    await Promise.all(someSongs_p);
    console.log("all done!!");
    i = j - 1;
  }
}

//  download playlist
async function playlistDownloader() {
  console.log(url);
  if (url === undefined) {
    console.log("no link found!!");
    process.exit(0);
  }
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--disable-notifications"],
    // headless: false,
    // defaultViewport: false,
  });
  const [page] = await browser.pages();
  await page.goto(url);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await scrollPageToBottom(page); // scroll to bottom of the page
  const allUrls = await page.$$eval("a#video-title", (allVids) => {
    const filtered = allVids.filter((ele) => {
      const title = ele.title;
      if (title === "[Private video]" || title === "[Deleted video]") {
        return false;
      } else {
        return true;
      }
    });
    return filtered.map((ele) => ({ url: ele.href, reqCount: 1 }));
  });
  await callUrlDownloader({ allUrls, browser });
  while (failedUrls.length !== 0) {
    let tempStorage = failedUrls;
    failedUrls = [];
    await callUrlDownloader({ allUrls: tempStorage, browser });
  }
  await browser.close();
  console.log("browser closed!!");
}

async function main() {
  if (url.includes("playlist")) {
    await playlistDownloader();
    console.log("song(s) downloaded!!");
  } else {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--disable-notifications"],
    });
    await songDownloder({
      url,
      browser,
      reqCount: 1,
      delay: true,
    });
    console.log("song downloaded!!");
    await browser.close();
  }
}

main()
  .then(() => {
    console.log("task completed!!");
    if (totallyFailed.length !== 0) {
      console.error("completely failed links [please try them individually!!]");
      console.error(JSON.stringify(totallyFailed, null, 2));
    }
    process.exit(0);
  })
  .catch((err) => console.error(err));
